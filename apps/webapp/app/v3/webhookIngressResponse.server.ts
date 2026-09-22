import type { IngestResult } from "@internal/webhook-engine";

/** What the public ingress answers a provider with for one ingest outcome. */
export type WebhookHttpResponse = {
  status: number;
  /** `null` for a bodiless answer (a 204). A `Response` with a 204 status refuses any body, even "". */
  body: string | null;
  contentType: string;
  headers?: Record<string, string>;
};

/**
 * Map an ingest outcome to the HTTP answer the provider sees. Defaults are 200 JSON on success and
 * 400 on missing credentials or a bad signature; an endpoint whose verifier artifact declares a
 * response contract (`acceptedStatus`, `rejectedStatus`) or handshake status gets those instead. The dashboard
 * test-send reports the same status and body inside its own result envelope.
 */
export function webhookHttpResponseFor(result: IngestResult): WebhookHttpResponse {
  switch (result.outcome) {
    case "accepted":
      return acceptedResponse(result.response?.acceptedStatus ?? 200, result.deliveryFriendlyId);
    case "duplicate":
      return acceptedResponse(result.response?.acceptedStatus ?? 200, result.deliveryId);
    case "handshake":
      return {
        status: result.status,
        body: result.status === 204 ? null : result.body,
        contentType: "text/plain",
      };
    case "verification_failed":
    case "secret_missing":
      return {
        status: result.response?.rejectedStatus ?? 400,
        body: JSON.stringify({ error: "Bad request" }),
        contentType: "application/json",
      };
    case "endpoint_not_found":
    case "endpoint_inactive":
      return {
        status: 404,
        body: JSON.stringify({ error: "Not found" }),
        contentType: "application/json",
      };
    case "method_not_allowed":
      return {
        status: 405,
        body: JSON.stringify({ error: "Method not allowed" }),
        headers: { Allow: (result.allowedMethods ?? ["POST"]).join(", ") },
        contentType: "application/json",
      };
    case "enqueue_failed":
      return {
        status: 500,
        body: JSON.stringify({ error: "Internal error" }),
        contentType: "application/json",
      };
  }
}

function acceptedResponse(status: 200 | 202 | 204, deliveryId: string | undefined) {
  return {
    status,
    body: status === 204 ? null : JSON.stringify({ received: true, deliveryId }),
    contentType: "application/json",
  };
}

/** Build the `Response` for the public ingress from a mapped answer. */
export function toWebhookHttpResponse(answer: WebhookHttpResponse): Response {
  return new Response(answer.body, {
    status: answer.status,
    headers: { ...answer.headers, "content-type": answer.contentType, "cache-control": "no-store" },
  });
}
