import {
  type ChatPostMessageArguments,
  type ChatPostMessageResponse,
  ErrorCode,
  type WebAPIHTTPError,
  type WebAPIPlatformError,
  type WebAPIRateLimitedError,
  type WebAPIRequestError,
} from "@slack/web-api";
import { subtle } from "crypto";
import {
  isIntegrationForService,
  type OrganizationIntegrationForService,
  OrgIntegrationRepository,
} from "~/models/orgIntegration.server";
import type { ProjectAlertWebhookProperties } from "~/models/projectAlert.server";
import { logger } from "~/services/logger.server";
import { decryptSecret } from "~/services/secrets/secretStore.server";
import { safeWebhookFetch, UnsafeWebhookUrlError } from "./safeWebhookFetch.server";

export class SkipRetryError extends Error {}

const PERMANENT_WEBHOOK_STATUSES = [401, 403, 404, 410];

export async function findSlackIntegration(
  prisma: { organizationIntegration: { findFirst: Function } },
  params: { integrationId?: string | null; organizationId: string },
  options: { includeDeleted?: boolean } = {}
): Promise<OrganizationIntegrationForService<"SLACK"> | null> {
  const findLatest = (where: { deletedAt?: null }) =>
    prisma.organizationIntegration.findFirst({
      where: { service: "SLACK", organizationId: params.organizationId, ...where },
      orderBy: { createdAt: "desc" },
      include: { tokenReference: true },
    });

  const integration = params.integrationId
    ? await prisma.organizationIntegration.findFirst({
        where: {
          id: params.integrationId,
          service: "SLACK",
          organizationId: params.organizationId,
          ...(options.includeDeleted ? {} : { deletedAt: null }),
        },
        include: { tokenReference: true },
      })
    : ((await findLatest({ deletedAt: null })) ??
      (options.includeDeleted ? await findLatest({}) : null));

  if (!integration || !isIntegrationForService(integration, "SLACK")) {
    return null;
  }

  return integration;
}

export async function postSlackMessage(
  integration: OrganizationIntegrationForService<"SLACK">,
  message: ChatPostMessageArguments
): Promise<ChatPostMessageResponse> {
  const client = await OrgIntegrationRepository.getAuthenticatedClientForIntegration(integration, {
    forceBotToken: true,
  });

  try {
    return await client.chat.postMessage({
      ...message,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    if (isWebAPIRateLimitedError(error)) {
      logger.warn("[alertTransport] Slack rate limited", { error, message });
      throw new Error("Slack rate limited");
    }

    if (isWebAPIHTTPError(error)) {
      logger.warn("[alertTransport] Slack HTTP error", { error, message });
      throw new Error("Slack HTTP error");
    }

    if (isWebAPIRequestError(error)) {
      logger.warn("[alertTransport] Slack request error", { error, message });
      throw new Error("Slack request error");
    }

    if (isWebAPIPlatformError(error)) {
      logger.warn("[alertTransport] Slack platform error", { error, message });

      if (error.data.error === "invalid_blocks") {
        throw new SkipRetryError("Slack invalid blocks");
      }

      if (error.data.error === "account_inactive") {
        throw new SkipRetryError("Slack account inactive");
      }

      throw new Error("Slack platform error");
    }

    logger.warn("[alertTransport] Failed to send slack message", { error, message });
    throw error;
  }
}

export async function deliverWebhookPayload(params: {
  url: string;
  secret: ProjectAlertWebhookProperties["secret"];
  encryptionKey: string;
  rawPayload: string;
  context?: { webhookId?: string; runId?: string };
  buildErrorMessage?: (host: string) => string;
  fetchWebhook?: typeof safeWebhookFetch;
}): Promise<Response> {
  const fetchWebhook = params.fetchWebhook ?? safeWebhookFetch;
  const secret = await decryptSecret(params.encryptionKey, params.secret);

  const key = await subtle.importKey(
    "raw",
    Buffer.from(secret, "utf-8"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await subtle.sign("HMAC", key, Buffer.from(params.rawPayload, "utf-8"));
  const signatureHex = Buffer.from(signature).toString("hex");

  const response = await fetchWebhook(params.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trigger-signature-hmacsha256": signatureHex,
    },
    body: params.rawPayload,
    signal: AbortSignal.timeout(5000),
  }).catch((error) => {
    if (error instanceof UnsafeWebhookUrlError) throw new SkipRetryError(error.message);
    throw error;
  });

  if (!response.ok) {
    logger.info("[alertTransport] Failed to send webhook", {
      status: response.status,
      statusText: response.statusText,
      urlHost: safeUrlHost(params.url),
      ...params.context,
    });
    const host = safeUrlHost(params.url);
    const message = params.buildErrorMessage?.(host) ?? `Failed to send alert webhook to ${host}`;

    if (PERMANENT_WEBHOOK_STATUSES.includes(response.status)) {
      throw new SkipRetryError(message);
    }
    throw new Error(message);
  }

  return response;
}

function safeUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function isWebAPIPlatformError(error: unknown): error is WebAPIPlatformError {
  return (error as WebAPIPlatformError).code === ErrorCode.PlatformError;
}

function isWebAPIRequestError(error: unknown): error is WebAPIRequestError {
  return (error as WebAPIRequestError).code === ErrorCode.RequestError;
}

function isWebAPIHTTPError(error: unknown): error is WebAPIHTTPError {
  return (error as WebAPIHTTPError).code === ErrorCode.HTTPError;
}

function isWebAPIRateLimitedError(error: unknown): error is WebAPIRateLimitedError {
  return (error as WebAPIRateLimitedError).code === ErrorCode.RateLimitedError;
}
