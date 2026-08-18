import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { readBodyWithCap } from "~/utils/readBodyWithCap.server";
import { webhookIngressRateLimiter } from "~/services/webhookIngressRateLimit.server";
import { webhookEngine } from "~/v3/webhookEngine.server";

// Public, unauthenticated webhook ingress. A Remix `action` (NOT
// createActionApiRoute, which parses JSON) so we can capture the raw bytes the
// signature scheme verifies. The engine resolves the endpoint (and its env id +
// type) from the globally-unique opaqueId, so this route runs no env query.
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }
  if (env.WEBHOOK_ENABLED !== "1" || env.WEBHOOK_INGRESS_ENABLED !== "1") {
    return json({ error: "Not found" }, { status: 404 });
  }

  const opaqueId = params.opaqueId;
  if (!opaqueId) return json({ error: "Not found" }, { status: 404 });

  // Per-opaqueId rate limit FIRST, before any DB or secret work.
  const rl = await webhookIngressRateLimiter.limit(opaqueId);
  if (!rl.success) {
    logger.info("webhook ingress rate limited", { opaqueId });
    return json({ error: "Too many requests" }, { status: 429 });
  }

  // Content-Length is a cheap fast-path reject; the capped streaming read is the real enforcement
  // (a chunked request can omit/understate Content-Length and would otherwise buffer unbounded).
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

  const result = await webhookEngine.ingest({
    opaqueId,
    rawBytes,
    headers,
    url: request.url, // url-secret reads this; never logged with its query string
  });

  switch (result.outcome) {
    case "accepted":
      logger.info("webhook ingress accepted", { opaqueId, deliveryId: result.deliveryId });
      return json({ received: true, deliveryId: result.deliveryFriendlyId }, { status: 200 });
    case "handshake":
      // Provider handshake echo (e.g. Slack url_verification): the challenge value, plain text, 200.
      return new Response(result.body, { status: 200, headers: { "content-type": "text/plain" } });
    case "duplicate":
      return json({ received: true, deliveryId: result.deliveryId }, { status: 200 });
    case "endpoint_not_found":
    case "endpoint_inactive":
      return json({ error: "Not found" }, { status: 404 });
    case "secret_missing":
      logger.warn("webhook ingress rejected: signing secret unset", { opaqueId });
      return json({ error: "Bad request" }, { status: 400 });
    case "verification_failed":
      logger.info("webhook ingress verification failed", { opaqueId });
      return json({ error: "Bad request" }, { status: 400 });
    case "enqueue_failed":
      logger.error("webhook ingress enqueue failed", { opaqueId, error: result.error });
      return json({ error: "Internal error" }, { status: 500 });
  }
}
