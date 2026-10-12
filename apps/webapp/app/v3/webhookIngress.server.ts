import { json } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { webhookIngressIpRateLimiter } from "~/services/webhookIngressIpRateLimit.server";
import { webhookIngressRateLimiter } from "~/services/webhookIngressRateLimit.server";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { readBodyWithCap } from "~/utils/readBodyWithCap.server";
import { webhookIngressEndpoint } from "~/v3/webhookLimits.server";

function tooManyRequests(retryAfterSeconds: number) {
  return json(
    { error: "Too many requests" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
  );
}

/**
 * Shared gate for the ingress routes: the feature flags, the opaque id, the per-IP budget for ids
 * that don't exist, and the per-endpoint rate limit from the endpoint's org, all before any uncached
 * database or secret work. Returns the response to send when the request is refused, or the opaque
 * id to continue with.
 */
export async function admitWebhookIngress(
  params: { opaqueId?: string },
  request: Request
): Promise<{ opaqueId: string } | Response> {
  if (env.WEBHOOK_ENABLED !== "1" || env.WEBHOOK_INGRESS_ENABLED !== "1") {
    return json({ error: "Not found" }, { status: 404 });
  }
  const opaqueId = params.opaqueId;
  if (!opaqueId) return json({ error: "Not found" }, { status: 404 });

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
    return tooManyRequests(Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000)));
  }
  return { opaqueId };
}

/**
 * The raw body and headers of an ingress POST, or a 413 response. Content-Length is a cheap
 * fast-path reject; the capped streaming read is the real enforcement, because a chunked request
 * can omit or understate Content-Length.
 */
export async function readWebhookIngressRequest(
  request: Request
): Promise<{ rawBytes: Uint8Array; headers: Record<string, string> } | Response> {
  const limitBytes = env.WEBHOOK_INGRESS_BODY_SIZE_LIMIT_MB * 1024 * 1024;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    return json({ error: "Payload too large" }, { status: 413 });
  }

  const rawBytes = await readBodyWithCap(request, limitBytes);
  if (rawBytes === null) {
    return json({ error: "Payload too large" }, { status: 413 });
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => (headers[k] = v));
  return { rawBytes, headers };
}
