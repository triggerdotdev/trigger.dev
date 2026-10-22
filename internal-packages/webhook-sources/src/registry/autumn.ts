import { type ProviderRegistryEntry } from "./types.js";

/**
 * Autumn delivers webhooks through Svix: `svix-id`/`svix-timestamp`/`svix-signature` headers,
 * HMAC-SHA256 base64 over `{id}.{timestamp}.{rawBody}`, keyed by the endpoint's `whsec_`-prefixed
 * secret that Svix issues from the Autumn dashboard. The event type rides the top-level `type` field,
 * with the event details under `data`.
 */
export const entry: ProviderRegistryEntry = {
  id: "autumn",
  label: "Autumn",
  category: "billing",
  docsUrl: "https://docs.useautumn.com/documentation/webhooks",
  preset: "svix",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
