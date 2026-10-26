import type { ChatPostMessageArguments } from "@slack/web-api";
import type { WatchObservedOutcome, WatchResolution } from "@internal/dashboard-agent-contracts";
import type { ProjectAlertChannel } from "@trigger.dev/database";
import assertNever from "assert-never";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
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
import {
  presentResolvedWatch,
  renderFactLines,
  watchNoteLine,
} from "~/presenters/v3/dashboardAgent";
import { sendAlertEmail } from "~/services/email.server";
import { logger } from "~/services/logger.server";
import { v3RunsPath } from "~/utils/pathBuilder";
import { alertsWorker } from "~/v3/alertsWorker.server";
import {
  SkipRetryError,
  findSlackIntegration,
  postSlackMessage,
  deliverWebhookPayload,
} from "./alertTransport.server";

/**
 * Deliver a fired dashboard-agent watch to the project's alert channels. No `ProjectAlert` row:
 * the job ids are the dedupe, and one job per channel keeps a failing webhook to itself.
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
  /** Optional so a job from an older build still delivers, falling back to `condition_met`. */
  resolution?: WatchResolution;
  observed?: WatchObservedOutcome;
};

export type DashboardAgentWatchChannelAlertPayload = DashboardAgentWatchAlertPayload & {
  channelId: string;
};

const WEBHOOK_VERSION = "2026-08-02";

/** Wording comes from the shared presenter, so every surface says the same sentence. */
function presentAlert(payload: DashboardAgentWatchAlertPayload) {
  return presentResolvedWatch({
    kind: payload.kind,
    identity: payload.identity,
    // Only a met condition fans out today; the fallback keeps an older payload
    // from silently presenting as something else.
    resolution: payload.resolution ?? "condition_met",
    observed: payload.observed ?? null,
  });
}

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

type ResolvedEnvironment = NonNullable<Awaited<ReturnType<typeof findEnvironment>>>;

function findEnvironment(payload: DashboardAgentWatchAlertPayload) {
  return $replica.runtimeEnvironment.findFirst({
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
}

function buildContext(environment: ResolvedEnvironment): ResolvedContext {
  return {
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
}

export class DeliverDashboardAgentWatchAlertService {
  async call(payload: DashboardAgentWatchAlertPayload): Promise<void> {
    const environment = await findEnvironment(payload);

    if (!environment) {
      logger.warn("[DeliverDashboardAgentWatchAlert] Environment not found", {
        watchId: payload.watchId,
      });
      return;
    }

    // Gate at delivery time, not only at subscribe time, so a plan change or a revoked
    // feature flag stops the alerts without anyone cleaning up channels.
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
      select: { id: true },
    });

    for (const channel of channels) {
      await alertsWorker.enqueue({
        // Stable per channel, so a fan-out retry re-enqueues the same job ids
        // rather than a second alert per channel.
        id: `watch-alert:${payload.watchId}:channel:${channel.id}`,
        job: "v3.deliverDashboardAgentWatchAlertChannel",
        payload: { ...payload, channelId: channel.id },
      });
    }
  }
}

export class DeliverDashboardAgentWatchChannelAlertService {
  async call(payload: DashboardAgentWatchChannelAlertPayload): Promise<void> {
    // Re-read the channel rather than trusting the fan-out's snapshot: an unsubscribe
    // between fan-out and delivery should stop the alert. The primary, since the
    // unsubscribe writes there and replica lag would send the mail anyway.
    const channel = await prisma.projectAlertChannel.findFirst({
      where: {
        id: payload.channelId,
        projectId: payload.projectId,
        enabled: true,
        alertTypes: { has: DASHBOARD_AGENT_WATCH_ALERT_TYPE },
      },
    });

    if (!channel) {
      logger.info("[DeliverDashboardAgentWatchAlert] Channel gone or unsubscribed", {
        watchId: payload.watchId,
        channelId: payload.channelId,
      });
      return;
    }

    const environment = await findEnvironment(payload);

    if (!environment) {
      logger.warn("[DeliverDashboardAgentWatchAlert] Environment not found", {
        watchId: payload.watchId,
      });
      return;
    }

    const context = buildContext(environment);

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
        return;
      }
      throw error;
    }
  }

  async #sendEmail(
    channel: ProjectAlertChannel,
    payload: DashboardAgentWatchChannelAlertPayload,
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

    const presentation = presentAlert(payload);

    await sendAlertEmail({
      email: "alert-dashboard-agent-watch",
      to: emailProperties.data.email,
      identity: payload.identity,
      kind: payload.kind,
      headline: presentation.headline,
      tone: presentation.tone,
      note: payload.note,
      noteLine: watchNoteLine(payload.note) ?? undefined,
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
    payload: DashboardAgentWatchChannelAlertPayload,
    context: ResolvedContext
  ): Promise<void> {
    const slackProperties = ProjectAlertSlackProperties.safeParse(channel.properties);
    if (!slackProperties.success) {
      logger.error("[DeliverDashboardAgentWatchAlert] Failed to parse slack properties", {
        issues: slackProperties.error.issues,
      });
      return;
    }

    const integration = await findSlackIntegration(
      prisma,
      {
        integrationId: slackProperties.data.integrationId,
        organizationId: payload.organizationId,
      },
      { includeDeleted: true }
    );

    if (!integration) {
      logger.error("[DeliverDashboardAgentWatchAlert] Slack integration not found");
      return;
    }

    await postSlackMessage(integration, {
      channel: slackProperties.data.channelId,
      ...this.#buildSlackMessage(payload, context),
    } as ChatPostMessageArguments);
  }

  async #sendWebhook(
    channel: ProjectAlertChannel,
    payload: DashboardAgentWatchChannelAlertPayload,
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
      // Stable across attempts, so a receiver can dedupe a redelivery. Unlike the
      // error-group webhook, which mints a nanoid per attempt.
      id: `watch:${payload.watchId}:channel:${payload.channelId}`,
      created: new Date(payload.firedAt),
      webhookVersion: WEBHOOK_VERSION,
      type: "alert.dashboard_agent_watch",
      object: {
        watch: {
          id: payload.watchId,
          identity: payload.identity,
          kind: payload.kind,
          note: payload.note,
          // `outcome` keeps its two-value encoding for receivers that already parse it;
          // `resolution` and `observed` carry the detail.
          outcome: "fired",
          resolution: payload.resolution ?? "condition_met",
          observed: payload.observed ?? null,
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

    await deliverWebhookPayload({
      url: webhookProperties.data.url,
      secret: webhookProperties.data.secret,
      encryptionKey: env.ENCRYPTION_KEY,
      rawPayload,
      buildErrorMessage: () =>
        `Failed to send watch alert webhook to ${webhookProperties.data.url}`,
    });
  }

  #buildSlackMessage(
    payload: DashboardAgentWatchChannelAlertPayload,
    context: ResolvedContext
  ): { text: string; blocks: object[] } {
    const facts = factList(payload.facts);
    const { headline } = presentAlert(payload);
    const noteLine = watchNoteLine(payload.note);

    return {
      text: [`${headline} [${context.environmentName}]`, noteLine, ...renderFactLines(facts)]
        .filter(Boolean)
        .join("\n"),
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [`*${headline}* [${context.environmentName}]`, noteLine]
              .filter(Boolean)
              .join("\n"),
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
 * The check's facts, flattened for display. Generic because the bag is per-watch-kind and
 * open-ended, and capped so a big bag can't blow up an email or a Slack block.
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
