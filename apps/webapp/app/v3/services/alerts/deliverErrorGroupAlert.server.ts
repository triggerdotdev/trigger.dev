import {
  type ChatPostMessageArguments,
  ErrorCode,
  type WebAPIPlatformError,
  type WebAPIRateLimitedError,
} from "@slack/web-api";
import { type ProjectAlertChannelType } from "@trigger.dev/database";
import assertNever from "assert-never";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { v3ErrorPath } from "~/utils/pathBuilder";
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
import { sendAlertEmail } from "~/services/email.server";
import { logger } from "~/services/logger.server";
import { decryptSecret } from "~/services/secrets/secretStore.server";
import { subtle } from "crypto";
import { generateErrorGroupWebhookPayload } from "./errorGroupWebhook.server";
import {
  buildErrorGroupSlackMessage,
  type ErrorAlertPayload,
} from "./errorGroupSlackMessage.server";
import { safeWebhookFetch } from "./safeWebhookFetch.server";

class SkipRetryError extends Error {}

export class DeliverErrorGroupAlertService {
  async call(payload: ErrorAlertPayload): Promise<void> {
    const channel = await prisma.projectAlertChannel.findFirst({
      where: { id: payload.channelId, enabled: true },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!channel) {
      logger.warn("[DeliverErrorGroupAlert] Channel not found or disabled", {
        channelId: payload.channelId,
      });
      return;
    }

    const errorLink = this.#buildErrorLink(
      channel.project.organization,
      channel.project,
      payload.error
    );

    try {
      switch (channel.type) {
        case "EMAIL":
          await this.#sendEmail(channel, payload, errorLink);
          break;
        case "SLACK":
          await this.#sendSlack(channel, payload, errorLink);
          break;
        case "WEBHOOK":
          await this.#sendWebhook(channel, payload, errorLink);
          break;
        default:
          assertNever(channel.type);
      }
    } catch (error) {
      if (error instanceof SkipRetryError) {
        logger.warn("[DeliverErrorGroupAlert] Skipping retry", {
          reason: (error as Error).message,
        });
        return;
      }
      throw error;
    }
  }

  #buildErrorLink(
    organization: { slug: string },
    project: { slug: string },
    error: ErrorAlertPayload["error"]
  ): string {
    return `${env.APP_ORIGIN}${v3ErrorPath(organization, project, { slug: error.environmentSlug }, { fingerprint: error.fingerprint })}`;
  }

  async #sendEmail(
    channel: {
      type: ProjectAlertChannelType;
      properties: unknown;
      project: { name: string; organization: { title: string } };
    },
    payload: ErrorAlertPayload,
    errorLink: string
  ): Promise<void> {
    const emailProperties = ProjectAlertEmailProperties.safeParse(channel.properties);
    if (!emailProperties.success) {
      logger.error("[DeliverErrorGroupAlert] Failed to parse email properties", {
        issues: emailProperties.error.issues,
      });
      return;
    }

    await sendAlertEmail({
      email: "alert-error-group",
      to: emailProperties.data.email,
      classification: payload.classification,
      taskIdentifier: payload.error.taskIdentifier,
      environment: payload.error.environmentName,
      error: {
        message: payload.error.errorMessage,
        type: payload.error.errorType,
        stackTrace: payload.error.sampleStackTrace || undefined,
      },
      occurrenceCount: payload.error.occurrenceCount,
      errorLink,
      organization: channel.project.organization.title,
      project: channel.project.name,
    });
  }

  async #sendSlack(
    channel: {
      type: ProjectAlertChannelType;
      properties: unknown;
      project: { organizationId: string; name: string; organization: { title: string } };
    },
    payload: ErrorAlertPayload,
    errorLink: string
  ): Promise<void> {
    const slackProperties = ProjectAlertSlackProperties.safeParse(channel.properties);
    if (!slackProperties.success) {
      logger.error("[DeliverErrorGroupAlert] Failed to parse slack properties", {
        issues: slackProperties.error.issues,
      });
      return;
    }

    const integration = slackProperties.data.integrationId
      ? await prisma.organizationIntegration.findFirst({
          where: {
            id: slackProperties.data.integrationId,
            organizationId: channel.project.organizationId,
          },
          include: { tokenReference: true },
        })
      : await prisma.organizationIntegration.findFirst({
          where: {
            service: "SLACK",
            organizationId: channel.project.organizationId,
          },
          orderBy: { createdAt: "desc" },
          include: { tokenReference: true },
        });

    if (!integration || !isIntegrationForService(integration, "SLACK")) {
      logger.error("[DeliverErrorGroupAlert] Slack integration not found");
      return;
    }

    const message = buildErrorGroupSlackMessage(payload, errorLink, channel.project.name);

    await this.#postSlackMessage(integration, {
      channel: slackProperties.data.channelId,
      ...message,
    } as ChatPostMessageArguments);
  }

  async #sendWebhook(
    channel: {
      type: ProjectAlertChannelType;
      properties: unknown;
      project: {
        id: string;
        externalRef: string;
        slug: string;
        name: string;
        organizationId: string;
        organization: { slug: string; title: string };
      };
    },
    payload: ErrorAlertPayload,
    errorLink: string
  ): Promise<void> {
    const webhookProperties = ProjectAlertWebhookProperties.safeParse(channel.properties);
    if (!webhookProperties.success) {
      logger.error("[DeliverErrorGroupAlert] Failed to parse webhook properties", {
        issues: webhookProperties.error.issues,
      });
      return;
    }

    const webhookPayload = generateErrorGroupWebhookPayload({
      classification: payload.classification,
      error: payload.error,
      organization: {
        id: channel.project.organizationId,
        slug: channel.project.organization.slug,
        name: channel.project.organization.title,
      },
      project: {
        id: channel.project.id,
        externalRef: channel.project.externalRef,
        slug: channel.project.slug,
        name: channel.project.name,
      },
      dashboardUrl: errorLink,
    });

    const rawPayload = JSON.stringify(webhookPayload);
    const hashPayload = Buffer.from(rawPayload, "utf-8");
    const secret = await decryptSecret(env.ENCRYPTION_KEY, webhookProperties.data.secret);
    const hmacSecret = Buffer.from(secret, "utf-8");
    const key = await subtle.importKey(
      "raw",
      hmacSecret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await subtle.sign("HMAC", key, hashPayload);
    const signatureHex = Buffer.from(signature).toString("hex");

    // Deliver via the SSRF-safe wrapper (see safeWebhookFetch.server.ts).
    const response = await safeWebhookFetch(webhookProperties.data.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trigger-signature-hmacsha256": signatureHex,
      },
      body: rawPayload,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      logger.info("[DeliverErrorGroupAlert] Failed to send webhook", {
        status: response.status,
        statusText: response.statusText,
        url: webhookProperties.data.url,
      });
      throw new Error(`Failed to send error group alert webhook to ${webhookProperties.data.url}`);
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
        if (
          (error as WebAPIPlatformError).data.error === "invalid_blocks" ||
          (error as WebAPIPlatformError).data.error === "account_inactive"
        ) {
          throw new SkipRetryError(`Slack: ${(error as WebAPIPlatformError).data.error}`);
        }
        throw new Error("Slack platform error");
      }
      throw error;
    }
  }
}

function isWebAPIPlatformError(error: unknown): error is WebAPIPlatformError {
  return (error as WebAPIPlatformError).code === ErrorCode.PlatformError;
}

function isWebAPIRateLimitedError(error: unknown): error is WebAPIRateLimitedError {
  return (error as WebAPIRateLimitedError).code === ErrorCode.RateLimitedError;
}
