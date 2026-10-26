import { type ProviderRegistryEntry } from "./types.js";

/**
 * Granola signs webhooks with Standard Webhooks: `webhook-id`/`webhook-timestamp`/`webhook-signature`
 * headers, HMAC-SHA256 base64 over `{id}.{timestamp}.{rawBody}`, keyed by the base64-decoded secret
 * after its `whsec_` prefix. `webhook-id` equals the body's `event_id` and is reused across retries.
 * Granola issues the secret once when the endpoint is created (Business and Enterprise plans). The
 * event type rides the top-level `event_type` field.
 */
export const entry: ProviderRegistryEntry = {
  id: "granola",
  label: "Granola",
  category: "productivity",
  docsUrl: "https://docs.granola.ai/webhooks",
  preset: "standard-webhooks",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "event_type" },
  sampleSource: "handauthored",
};
