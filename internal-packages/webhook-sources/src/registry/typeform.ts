import { type ProviderRegistryEntry } from "./types.js";

/**
 * Typeform signs webhooks with a `Typeform-Signature` header formatted as `sha256=<base64>` HMAC-SHA256
 * over the raw request body. The header name and base64 encoding don't match our `github` preset (which
 * requires `x-hub-signature-256` with a hex-encoded digest), nor any other preset, so this ships
 * sample-only without a custom verifier config.
 */
export const entry: ProviderRegistryEntry = {
  id: "typeform",
  label: "Typeform",
  category: "forms",
  docsUrl: "https://www.typeform.com/developers/webhooks/secure-your-webhooks/",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "event_type" },
  sampleSource: "handauthored",
};
