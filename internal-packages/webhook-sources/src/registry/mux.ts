import { type ProviderRegistryEntry } from "./types.js";

/**
 * Mux signs webhooks with a `Mux-Signature` header of the form `t=<unix seconds>,v1=<hex>`, where `v1`
 * is a hex-encoded HMAC-SHA256 of `{t}.{raw body}` keyed by the endpoint's signing secret (used as
 * UTF-8). The default replay tolerance is five minutes. Each payload carries a unique top-level `id`
 * for idempotency, and the event type rides the top-level `type` field (e.g. `video.asset.ready`).
 */
export const entry: ProviderRegistryEntry = {
  id: "mux",
  label: "Mux",
  category: "storage",
  docsUrl: "https://www.mux.com/docs/core/verify-webhook-signatures",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
