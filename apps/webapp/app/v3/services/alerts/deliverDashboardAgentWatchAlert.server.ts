import {
  type ChatPostMessageArguments,
  ErrorCode,
  type WebAPIPlatformError,
  type WebAPIRateLimitedError,
} from "@slack/web-api";
import { type ProjectAlertChannel } from "@trigger.dev/database";
import assertNever from "assert-never";
import { subtle } from "crypto";
import { nanoid } from "nanoid";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import {
  isIntegrationForService,
  type OrganizationIntegrationForService,
  OrgIntegrationRepository,
} from "~/models/orgIntegration.server";
import {
  ProjectAlertEmailProperties,
  ProjectAlertSlackProperties,
  ProjectAlertWebhookProperties,
} from "~/models/projectAlert.server";
import { mintDashboardAgentAlertUnsubscribeToken } from "~/services/dashboardAgentAlertUnsubscribeToken.server";
import {
  canUseDashboardAgentAlerts,
  DASHBOARD_AGENT_WATCH_ALERT_TYPE,
} from "~/services/dashboardAgentWatchAlerts.server";
import { sendAlertEmail } from "~/services/email.server";
import { logger } from "~/services/logger.server";
import { decryptSecret } from "~/services/secrets/secretStore.server";
import { v3RunsPath } from "~/utils/pathBuilder";
import { safeWebhookFetch } from "./safeWebhookFetch.server";

/**
 * Deliver a fired dashboard-agent watch to the project's alert channels.
 *
 * Payload-carried, like the error-group alert: no `ProjectAlert` row. A watch is
 * already a durable row in the dashboard-agent database with its own delivery
 * state, so a second row tracking the same event would only be a thing to keep in
 * sync. The job id (`watch-alert:{watchId}`) is the dedupe.
 *
 * One job fans out over every matching channel, so a partial failure retries the
 * whole watch — acceptable because the alert is factual and idempotent to receive
 * twice, and a per-channel job would need a second dedupe key anyway.
 */
export type DashboardAgentWatchAlertPayload = {
  watchId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
  identity: string;
  kind: string;
  note: string;
  firedAt: string;
  facts: Record<string, unknown>;
};

/** Bumped when the webhook body's shape changes. */
const WEBHOOK_VERSION = "2026-07-29";

class SkipRetryError extends Error {}

type ResolvedContext = {
  environmentName: string;
  environmentSlug: string;
  organizationSlug: string;
  organizationTitle: string;
  projectName: string;
  projectSlug: string;
  projectRef: string;
  dashboardLink: string;
};

export class DeliverDashboardAgentWatchAlertService {
  async call(payload: DashboardAgentWatchAlertPayload): Promise<void> {
    const environment = await $replica.runtimeEnvironment.findFirst({
      where: { id: payload.environmentId, projectId: payload.projectId },
      select: {
        type: true,
        slug: true,
        branchName: true,
        project: {
          select: {
            name: true,
            slug: true,
            externalRef: true,
            organization: { select: { slug: true, title: true } },
          },
        },
      },
    });

    if (!environment) {
      logger.warn("[DeliverDashboardAgentWatchAlert] Environment not found", {
        watchId: payload.watchId,
      });
      return;
    }

    // The gate, checked at DELIVERY and not only at subscribe time, so a plan
    // change or a revoked feature flag stops the alerts without anyone having to
    // clean up channels.
    const gate = await canUseDashboardAgentAlerts({
      userId: payload.userId,
      organizationId: payload.organizationId,
      organizationSlug: environment.project.organization.slug,
    });
    if (!gate.allowed) {
      logger.info("[DeliverDashboardAgentWatchAlert] Not allowed for this organization", {
        watchId: payload.watchId,
        reason: gate.reason,
      });
      return;
    }

    const channels = await $replica.projectAlertChannel.findMany({
      where: {
        projectId: payload.projectId,
        enabled: true,
        alertTypes: { has: DASHBOARD_AGENT_WATCH_ALERT_TYPE },
        environmentTypes: { has: environment.type },
      },
    });

    if (channels.length === 0) return;

    const context: ResolvedContext = {
      environmentName: environment.branchName ?? environment.slug,
      environmentSlug: environment.slug,
      organizationSlug: environment.project.organization.slug,
      organizationTitle: environment.project.organization.title,
      projectName: environment.project.name,
      projectSlug: environment.project.slug,
      projectRef: environment.project.externalRef,
      dashboardLink: `${env.APP_ORIGIN}${v3RunsPath(
        { slug: environment.project.organization.slug },
        { slug: environment.project.slug },
        { slug: environment.slug }
      )}`,
    };

    for (const channel of channels) {
      try {
        switch (channel.type) {
          case "EMAIL":
            await this.#sendEmail(channel, payload, context);
            break;
          case "SLACK":
            await this.#sendSlack(channel, payload, context);
            break;
          case "WEBHOOK":
            await this.#sendWebhook(channel, payload, context);
            break;
          default:
            assertNever(channel.type);
        }
      } catch (error) {
        if (error instanceof SkipRetryError) {
          logger.warn("[DeliverDashboardAgentWatchAlert] Skipping retry", {
            watchId: payload.watchId,
            channelId: channel.id,
            reason: error.message,
          });
          continue;
        }
        throw error;
      }
    }
  }

  async #sendEmail(
    channel: ProjectAlertChannel,
    payload: DashboardAgentWatchAlertPayload,
    context: ResolvedContext
  ): Promise<void> {
    const emailProperties = ProjectAlertEmailProperties.safeParse(channel.properties);
    if (!emailProperties.success) {
      logger.error("[DeliverDashboardAgentWatchAlert] Failed to parse email properties", {
        issues: emailProperties.error.issues,
      });
      return;
    }

    const token = await mintDashboardAgentAlertUnsubscribeToken({
      channelId: channel.id,
      alertType: DASHBOARD_AGENT_WATCH_ALERT_TYPE,
    });

    await sendAlertEmail({
      email: "alert-dashboard-agent-watch",
      to: emailProperties.data.email,
      identity: payload.identity,
      kind: payload.kind,
      note: payload.note,
      firedAt: payload.firedAt,
      facts: factList(payload.facts),
      dashboardLink: context.dashboardLink,
      unsubscribeLink: `${env.APP_ORIGIN}/resources/dashboard-agent/alerts/${channel.id}/unsubscribe?token=${encodeURIComponent(token)}`,
      organization: context.organizationTitle,
      project: context.projectName,
      environment: context.environmentName,
    });
  }

  async #sendSlack(
    channel: ProjectAlertChannel,
    payload: DashboardAgentWatchAlertPayload,
    context: ResolvedContext
  ): Promise<void> {
    const slackProperties = ProjectAlertSlackProperties.safeParse(channel.properties);
    if (!slackProperties.success) {
      logger.error("[DeliverDashboardAgentWatchAlert] Failed to parse slack properties", {
        issues: slackProperties.error.issues,
      });
      return;
    }

    const integration = slackProperties.data.integrationId
      ? await prisma.organizationIntegration.findFirst({
          where: {
            id: slackProperties.data.integrationId,
            organizationId: payload.organizationId,
          },
          include: { tokenReference: true },
        })
      : await prisma.organizationIntegration.findFirst({
          where: { service: "SLACK", organizationId: payload.organizationId },
          orderBy: { createdAt: "desc" },
          include: { tokenReference: true },
        });

    if (!integration || !isIntegrationForService(integration, "SLACK")) {
      logger.error("[DeliverDashboardAgentWatchAlert] Slack integration not found");
      return;
    }

    await this.#postSlackMessage(integration, {
      channel: slackProperties.data.channelId,
      ...this.#buildSlackMessage(payload, context),
    } as ChatPostMessageArguments);
  }

  async #sendWebhook(
    channel: ProjectAlertChannel,
    payload: DashboardAgentWatchAlertPayload,
    context: ResolvedContext
  ): Promise<void> {
    const webhookProperties = ProjectAlertWebhookProperties.safeParse(channel.properties);
    if (!webhookProperties.success) {
      logger.error("[DeliverDashboardAgentWatchAlert] Failed to parse webhook properties", {
        issues: webhookProperties.error.issues,
      });
      return;
    }

    const rawPayload = JSON.stringify({
      id: nanoid(),
      created: new Date(),
      webhookVersion: WEBHOOK_VERSION,
      type: "alert.dashboard_agent_watch",
      object: {
        watch: {
          id: payload.watchId,
          identity: payload.identity,
          kind: payload.kind,
          note: payload.note,
          outcome: "fired",
          firedAt: payload.firedAt,
          facts: payload.facts,
        },
        environment: { id: payload.environmentId, name: context.environmentName },
        organization: {
          id: payload.organizationId,
          slug: context.organizationSlug,
          name: context.organizationTitle,
        },
        project: {
          id: payload.projectId,
          ref: context.projectRef,
          slug: context.projectSlug,
          name: context.projectName,
        },
        dashboardUrl: context.dashboardLink,
      },
    });

    const secret = await decryptSecret(env.ENCRYPTION_KEY, webhookProperties.data.secret);
    const key = await subtle.importKey(
      "raw",
      Buffer.from(secret, "utf-8"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await subtle.sign("HMAC", key, Buffer.from(rawPayload, "utf-8"));

    // Deliver via the SSRF-safe wrapper (see safeWebhookFetch.server.ts).
    const response = await safeWebhookFetch(webhookProperties.data.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trigger-signature-hmacsha256": Buffer.from(signature).toString("hex"),
      },
      body: rawPayload,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      logger.info("[DeliverDashboardAgentWatchAlert] Failed to send webhook", {
        status: response.status,
        url: webhookProperties.data.url,
      });
      throw new Error(`Failed to send watch alert webhook to ${webhookProperties.data.url}`);
    }
  }

  async #postSlackMessage(
    integration: OrganizationIntegrationForService<"SLACK">,
    message: ChatPostMessageArguments
  ) {
    const client = await OrgIntegrationRepository.getAuthenticatedClientForIntegration(
      integration,
      { forceBotToken: true }
    );

    try {
      return await client.chat.postMessage({
        ...message,
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (error) {
      if (isWebAPIRateLimitedError(error)) {
        throw new Error("Slack rate limited");
      }
      if (isWebAPIPlatformError(error)) {
        const code = (error as WebAPIPlatformError).data.error;
        if (code === "invalid_blocks" || code === "account_inactive") {
          throw new SkipRetryError(`Slack: ${code}`);
        }
        throw new Error("Slack platform error");
      }
      throw error;
    }
  }

  #buildSlackMessage(
    payload: DashboardAgentWatchAlertPayload,
    context: ResolvedContext
  ): { text: string; blocks: object[] } {
    const facts = factList(payload.facts);

    return {
      text: `Watch fired: ${payload.identity} [${context.environmentName}]`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Watch fired: ${payload.identity}* [${context.environmentName}]\nYou asked to be told when: ${payload.note}`,
          },
        },
        ...(facts.length > 0
          ? [
              {
                type: "section",
                fields: facts.slice(0, 10).map((fact) => ({
                  type: "mrkdwn",
                  text: `*${fact.label}:*\n${fact.value}`,
                })),
              },
            ]
          : []),
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open dashboard" },
              url: context.dashboardLink,
              style: "primary",
            },
          ],
        },
      ],
    };
  }
}

/**
 * The check's facts, flattened for display. The facts bag is per-watch-kind and
 * open-ended, so this stays dumb on purpose: labelled scalars, nested values as
 * compact JSON, and a cap so a big bag can't blow up an email or a Slack block.
 */
function factList(facts: Record<string, unknown>): Array<{ label: string; value: string }> {
  return Object.entries(facts)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, 12)
    .map(([key, value]) => ({
      label: humanizeFactKey(key),
      value: typeof value === "object" ? JSON.stringify(value).slice(0, 200) : String(value),
    }));
}

function humanizeFactKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isWebAPIPlatformError(error: unknown): error is WebAPIPlatformError {
  return (error as WebAPIPlatformError).code === ErrorCode.PlatformError;
}

function isWebAPIRateLimitedError(error: unknown): error is WebAPIRateLimitedError {
  return (error as WebAPIRateLimitedError).code === ErrorCode.RateLimitedError;
}
