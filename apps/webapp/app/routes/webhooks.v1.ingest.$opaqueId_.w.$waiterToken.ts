import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { logger } from "~/services/logger.server";
import { admitWebhookIngress, readWebhookIngressRequest } from "~/v3/webhookIngress.server";
import { webhookEngine } from "~/v3/webhookEngine.server";
import { toWebhookHttpResponse, webhookHttpResponseFor } from "~/v3/webhookIngressResponse.server";

/**
 * A URL-matched webhook waiter's own ingress URL (`/webhooks/v1/ingest/<opaqueId>/w/<waiterId>.<sig>`),
 * for providers that take a per-request callback URL. The delivery is verified with the endpoint's
 * verifier and can only complete that waiter; it never fans out to the endpoint's subscribers.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  const admitted = await admitWebhookIngress(params);
  if (admitted instanceof Response) return admitted;
  const { opaqueId } = admitted;

  if (request.method !== "POST" || !params.waiterToken) {
    return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  const body = await readWebhookIngressRequest(request);
  if (body instanceof Response) return body;

  const result = await webhookEngine.ingestWaiter({
    opaqueId,
    rawBytes: body.rawBytes,
    headers: body.headers,
    url: request.url,
    waiterToken: params.waiterToken,
  });

  if (result.outcome === "accepted") {
    logger.info("webhook waiter ingress accepted", { opaqueId, deliveryId: result.deliveryId });
  } else if (result.outcome === "enqueue_failed") {
    logger.error("webhook waiter ingress enqueue failed", { opaqueId, error: result.error });
  }

  return toWebhookHttpResponse(webhookHttpResponseFor(result));
}
