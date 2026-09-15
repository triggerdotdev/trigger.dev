import { type ProviderRegistryEntry } from "./types.js";

/**
 * Brex signs webhooks with the Standard Webhooks scheme: `Webhook-Id` / `Webhook-Timestamp` /
 * `Webhook-Signature` headers, HMAC-SHA256 base64 over `{id}.{timestamp}.{rawBody}`, verified
 * against a base64-decoded secret from `GET /v1/webhooks/secrets` (their docs' own example secret
 * has no `whsec_` prefix, but our `svix` preset's prefix strip is a no-op when absent). Matches
 * our `svix` preset. The discriminant is `event_type` (not `type`) at the top level of the body.
 */
export const entry: ProviderRegistryEntry = {
  id: "brex",
  label: "Brex",
  category: "fintech",
  docsUrl: "https://developer.brex.com/docs/webhooks/",
  preset: "svix",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "event_type" },
  sampleSource: "handauthored",
};
