import { type ProviderRegistryEntry } from "./types.js";

/**
 * PlanetScale signs webhooks with an `X-PlanetScale-Signature` header carrying a bare hex-encoded
 * HMAC-SHA256 of the raw request body, keyed by the webhook's secret (shown under the database's
 * Settings > Webhooks > "Show secret", used as UTF-8). There is no timestamp in the signature and no
 * delivery id header; the body carries a unix-seconds `timestamp`. The event name rides the top-level
 * `event` field, and `resource` reuses the matching API response shape (Branch, DeployRequest, etc.).
 */
export const entry: ProviderRegistryEntry = {
  id: "planetscale",
  label: "PlanetScale",
  category: "data",
  docsUrl: "https://planetscale.com/docs/api/webhooks",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "event" },
  sampleSource: "handauthored",
};
