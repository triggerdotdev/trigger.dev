import { type ProviderRegistryEntry } from "./types.js";

/**
 * ElevenLabs signs post-call webhooks with `elevenlabs-signature: t=<unix>,v0=<hex>`, an HMAC-SHA256
 * of `{timestamp}.{rawBody}`. Structurally close to our `stripe` preset (timestamped HMAC-SHA256), but
 * the header name and the `v0=` value prefix (vs. `v1=`) don't match exactly, so this ships sample-only
 * (no preset) until a custom verifier config exists for this wire format.
 */
export const entry: ProviderRegistryEntry = {
  id: "elevenlabs",
  label: "ElevenLabs",
  category: "voice",
  docsUrl: "https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
