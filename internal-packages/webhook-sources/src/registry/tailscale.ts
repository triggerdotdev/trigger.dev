import { type ProviderRegistryEntry } from "./types.js";

/**
 * Tailscale signs webhooks with a `Tailscale-Webhook-Signature` header of the form
 * `t=<unix seconds>,v1=<hex>`, where `v1` is a hex-encoded HMAC-SHA256 of `{t}.{raw body}` keyed by the
 * endpoint's webhook secret (used as UTF-8). Tailscale suggests rejecting timestamps older than five
 * minutes. The body is always a JSON array of events, so the type of the first event is read from
 * `0.type`; there is no per-delivery or per-event id in headers or body.
 */
export const entry: ProviderRegistryEntry = {
  id: "tailscale",
  label: "Tailscale",
  category: "hosting-infra",
  docsUrl: "https://tailscale.com/kb/1213/webhooks",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "0.type" },
  sampleSource: "handauthored",
};
