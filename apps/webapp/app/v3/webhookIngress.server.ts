import { json } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { webhookIngressRateLimiter } from "~/services/webhookIngressRateLimit.server";
import { readBodyWithCap } from "~/utils/readBodyWithCap.server";

/**
 * Shared gate for the ingress routes: the feature flags, the opaque id, and the per-endpoint rate
 * limit, which runs before any database or secret work. Returns the response to send when the
 * request is refused, or the opaque id to continue with.
 */
export async function admitWebhookIngress(params: {
  opaqueId?: string;
}): Promise<{ opaqueId: string } | Response> {
  if (env.WEBHOOK_ENABLED !== "1" || env.WEBHOOK_INGRESS_ENABLED !== "1") {
    return json({ error: "Not found" }, { status: 404 });
  }
  const opaqueId = params.opaqueId;
  if (!opaqueId) return json({ error: "Not found" }, { status: 404 });

  const rl = await webhookIngressRateLimiter.limit(opaqueId);
  if (!rl.success) {
    logger.info("webhook ingress rate limited", { opaqueId });
    return json({ error: "Too many requests" }, { status: 429 });
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
