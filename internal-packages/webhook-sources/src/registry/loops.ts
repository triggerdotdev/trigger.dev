import { type ProviderRegistryEntry } from "./types.js";

/**
 * Loops signs webhooks with Standard Webhooks: `webhook-id`/`webhook-timestamp`/`webhook-signature`
 * headers, HMAC-SHA256 base64 over `{id}.{timestamp}.{rawBody}`, keyed by the base64-decoded secret
 * after its `whsec_` prefix. The signature header is a whitespace-separated list of `v1,<base64>`
 * entries (both old and new secrets sign for 24 hours after a roll), and the timestamp is in seconds
 * with a documented 300 second tolerance. Loops issues the secret in Settings, Webhooks. The event
 * type rides the top-level `eventName` field.
 */
export const entry: ProviderRegistryEntry = {
  id: "loops",
  label: "Loops",
  category: "email",
  docsUrl: "https://loops.so/docs/webhooks",
  preset: "standard-webhooks",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "eventName" },
  sampleSource: "handauthored",
};
