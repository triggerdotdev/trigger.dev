import { type ProviderRegistryEntry } from "./types.js";

/**
 * Hookdeck relays deliveries from another provider to a destination, so the body is the original
 * provider's payload. It signs each forwarded request with an `x-hookdeck-signature` header: a
 * base64-encoded HMAC-SHA256 of the raw body, keyed by the project's signing secret (used as UTF-8).
 * While a secret is being rolled with a delay it also sends `x-hookdeck-signature-2`, signed with the
 * previous secret. `x-hookdeck-eventid` names the Hookdeck event and is the same on every attempt.
 * There is no timestamp. The event type depends on the source; `type` covers Stripe-style payloads.
 */
export const entry: ProviderRegistryEntry = {
  id: "hookdeck",
  label: "Hookdeck",
  category: "hosting-infra",
  docsUrl: "https://hookdeck.com/docs/authentication",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
