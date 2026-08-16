import { type ProviderRegistryEntry } from "./types.js";

/**
 * Linear signs webhooks with a custom scheme: a `Linear-Signature` header carrying a hex-encoded
 * HMAC-SHA256 signature of the raw body, keyed by the webhook's signing secret. The header name and
 * value format don't match our `github` preset (`x-hub-signature-256`, `sha256=<hex>` prefix) or any
 * other preset, so this ships sample-only with no preset. The resource type rides the top-level `type`
 * field in the body, but the meaningful event also depends on the top-level `action` (create/update/
 * remove).
 */
export const entry: ProviderRegistryEntry = {
  id: "linear",
  label: "Linear",
  category: "pm",
  docsUrl: "https://linear.app/developers/webhooks",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
