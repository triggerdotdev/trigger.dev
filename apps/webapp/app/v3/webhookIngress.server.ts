import { json } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { webhookIngressIpRateLimiter } from "~/services/webhookIngressIpRateLimit.server";
import {
  chargeWebhookIngressBody,
  type IngressRateLimit,
  webhookIngressEnvironmentRateLimiter,
  webhookIngressRateLimiter,
} from "~/services/webhookIngressRateLimit.server";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { readBodyWithCap } from "~/utils/readBodyWithCap.server";
import { webhookIngressEndpoint } from "~/v3/webhookLimits.server";

/**
 * Every ingress refusal closes the connection. Most are sent before the body is read, and on a
 * kept-alive connection the unread body would be taken as the start of the client's next request,
 * which then hangs.
 */
function refuse(error: string, status: number, headers: Record<string, string> = {}) {
  return json({ error }, { status, headers: { ...headers, Connection: "close" } });
}

function tooManyRequests(retryAfterSeconds: number) {
  return refuse("Too many requests", 429, { "Retry-After": String(retryAfterSeconds) });
}

/** An admitted ingress request: its opaque id, and its environment's limit when the id resolved. */
export type AdmittedWebhookIngress = {
  opaqueId: string;
  environment?: { id: string; limit: IngressRateLimit };
};

function retryAfterSeconds(reset: number) {
  return Math.max(1, Math.ceil((reset - Date.now()) / 1000));
}

/**
 * Shared gate for the ingress routes: the feature flags, the opaque id, the per-IP budget for ids
 * that don't exist, the per-endpoint rate limit, and the first token of the per-environment limit,
 * from the endpoint's org, all before any uncached database or secret work. Returns the response to
 * send when the request is refused, or the request to continue with.
 */
export async function admitWebhookIngress(
  params: { opaqueId?: string },
  request: Request
): Promise<AdmittedWebhookIngress | Response> {
  if (env.WEBHOOK_ENABLED !== "1" || env.WEBHOOK_INGRESS_ENABLED !== "1") {
    return refuse("Not found", 404);
  }
  const opaqueId = params.opaqueId;
  if (!opaqueId) return refuse("Not found", 404);

  const ip = extractClientIp(request.headers.get("x-forwarded-for"));
  const blockedFor = webhookIngressIpRateLimiter.blockedFor(ip);
  let endpoint = await webhookIngressEndpoint(opaqueId, {
    cachedOnly: blockedFor !== undefined,
  });
  if (
    ip &&
    blockedFor !== undefined &&
    endpoint.exists === undefined &&
    webhookIngressIpRateLimiter.takeBlockedLookup(ip)
  ) {
    endpoint = await webhookIngressEndpoint(opaqueId);
  }
  if (blockedFor !== undefined && endpoint.exists !== true) return tooManyRequests(blockedFor);
  if (endpoint.exists === false) {
    const gate = await webhookIngressIpRateLimiter.limit(ip);
    if (!gate.success) return tooManyRequests(gate.retryAfterSeconds);
  }

  const rl = await webhookIngressRateLimiter.limit(opaqueId, {
    tokens: endpoint.limits.endpointRateLimitTokens,
    windowSeconds: endpoint.limits.endpointRateLimitWindowSeconds,
  });
  if (!rl.success) {
    logger.info("webhook ingress rate limited", { opaqueId });
    return tooManyRequests(retryAfterSeconds(rl.reset));
  }

  if (!endpoint.environmentId) return { opaqueId };
  const environment = {
    id: endpoint.environmentId,
    limit: {
      tokens: endpoint.limits.environmentRateLimitTokens,
      windowSeconds: endpoint.limits.environmentRateLimitWindowSeconds,
    },
  };
  const envLimit = await webhookIngressEnvironmentRateLimiter.limit(
    environment.id,
    environment.limit
  );
  if (!envLimit.success) {
    logger.info("webhook ingress environment rate limited", {
      opaqueId,
      environmentId: environment.id,
    });
    return tooManyRequests(retryAfterSeconds(envLimit.reset));
  }
  return { opaqueId, environment };
}

/**
 * The raw body and headers of an ingress POST, or a 413 or 429 response. Content-Length is a cheap
 * fast-path reject; the capped streaming read is the real enforcement, because a chunked request
 * can omit or understate Content-Length. Once the body is read, the rest of its size-based cost is
 * charged to the environment's limit (admission already charged its first token). A body the
 * capped read refuses is charged as the cap plus one byte, since that much was read before the
 * 413, so oversized requests still use up the environment's budget.
 */
export async function readWebhookIngressRequest(
  request: Request,
  admitted: AdmittedWebhookIngress
): Promise<{ rawBytes: Uint8Array; headers: Record<string, string> } | Response> {
  const limitBytes = env.WEBHOOK_INGRESS_BODY_SIZE_LIMIT_MB * 1024 * 1024;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    return refuse("Payload too large", 413);
  }

  const rawBytes = await readBodyWithCap(request, limitBytes);
  if (rawBytes === null) {
    if (admitted.environment) {
      await chargeWebhookIngressBody(
        webhookIngressEnvironmentRateLimiter,
        admitted.environment,
        limitBytes + 1
      );
    }
    return refuse("Payload too large", 413);
  }

  if (admitted.environment) {
    const envLimit = await chargeWebhookIngressBody(
      webhookIngressEnvironmentRateLimiter,
      admitted.environment,
      rawBytes.byteLength
    );
    if (!envLimit.success) {
      logger.info("webhook ingress environment rate limited by body size", {
        opaqueId: admitted.opaqueId,
        environmentId: admitted.environment.id,
        bytes: rawBytes.byteLength,
      });
      return tooManyRequests(retryAfterSeconds(envLimit.reset));
    }
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => (headers[k] = v));
  return { rawBytes, headers };
}
