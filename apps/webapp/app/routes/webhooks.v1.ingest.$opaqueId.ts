import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { readBodyWithCap } from "~/utils/readBodyWithCap.server";
import { webhookIngressRateLimiter } from "~/services/webhookIngressRateLimit.server";
import { webhookEngine } from "~/v3/webhookEngine.server";
import { toWebhookHttpResponse, webhookHttpResponseFor } from "~/v3/webhookIngressResponse.server";

/**
 * Shared gate for both methods: the feature flags, the opaque id, and the per-endpoint rate limit,
 * which runs before any database or secret work. Returns the response to send when the request is
 * refused, or the opaque id to continue with.
 */
async function admit(params: { opaqueId?: string }): Promise<{ opaqueId: string } | Response> {
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
 * GET: a provider's verification of the endpoint URL (Meta's `hub.challenge` flow). The engine
 * answers it from the endpoint's declared GET handshake, or refuses with 405 when the source
 * declares none. Never records a delivery.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const admitted = await admit(params);
  if (admitted instanceof Response) return admitted;
  const { opaqueId } = admitted;

  const query: Record<string, string> = {};
  new URL(request.url).searchParams.forEach((v, k) => (query[k] = v));
  const result = await webhookEngine.verifyGetHandshake({ opaqueId, query });
  if (result.outcome === "verification_failed") {
    logger.info("webhook ingress GET handshake rejected", { opaqueId, error: result.error });
  }
  return toWebhookHttpResponse(webhookHttpResponseFor(result));
}

// Public, unauthenticated webhook ingress. A Remix `action` (NOT
// createActionApiRoute, which parses JSON) so we can capture the raw bytes the
// signature scheme verifies. The engine resolves the endpoint (and its env id +
// type) from the globally-unique opaqueId, so this route runs no env query.
export async function action({ request, params }: ActionFunctionArgs) {
  const admitted = await admit(params);
  if (admitted instanceof Response) return admitted;
  const { opaqueId } = admitted;

  if (request.method !== "POST") {
    const result = await webhookEngine.rejectUnsupportedMethod(opaqueId);
    return toWebhookHttpResponse(webhookHttpResponseFor(result));
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
      break;
    case "secret_missing":
      logger.warn("webhook ingress rejected: signing secret unset", { opaqueId });
      break;
    case "verification_failed":
      logger.info("webhook ingress verification failed", { opaqueId });
      break;
    case "enqueue_failed":
      logger.error("webhook ingress enqueue failed", { opaqueId, error: result.error });
      break;
    default:
      break;
  }

  return toWebhookHttpResponse(webhookHttpResponseFor(result));
}
