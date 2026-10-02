import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { logger } from "~/services/logger.server";
import { admitWebhookIngress, readWebhookIngressRequest } from "~/v3/webhookIngress.server";
import { webhookEngine } from "~/v3/webhookEngine.server";
import { toWebhookHttpResponse, webhookHttpResponseFor } from "~/v3/webhookIngressResponse.server";

/**
 * GET: a provider's verification of the endpoint URL (Meta's `hub.challenge` flow). The engine
 * answers it from the endpoint's declared GET handshake, or refuses with 405 when the source
 * declares none. Never records a delivery.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const admitted = await admitWebhookIngress(params);
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
  const admitted = await admitWebhookIngress(params);
  if (admitted instanceof Response) return admitted;
  const { opaqueId } = admitted;

  if (request.method !== "POST") {
    const result = await webhookEngine.rejectUnsupportedMethod(opaqueId);
    return toWebhookHttpResponse(webhookHttpResponseFor(result));
  }

  const body = await readWebhookIngressRequest(request);
  if (body instanceof Response) return body;
  const { rawBytes, headers } = body;

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
