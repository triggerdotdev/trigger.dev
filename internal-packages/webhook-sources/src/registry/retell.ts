import { type ProviderRegistryEntry } from "./types.js";

/**
 * Retell AI signs webhooks with its own scheme: `x-retell-signature: v={timestamp_ms},d={hex_digest}`,
 * HMAC-SHA256 over `rawBody + timestamp` (string concatenation, not dot-joined), keyed by an API key
 * (no `whsec_`-style prefix). This does not match any of our verifier presets, so these ship sample-only.
 */
export const entry: ProviderRegistryEntry = {
  id: "retell",
  label: "Retell AI",
  category: "voice",
  docsUrl: "https://docs.retellai.com/features/secure-webhook",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "event" },
  sampleSource: "handauthored",
};
