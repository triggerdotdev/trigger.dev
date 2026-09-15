import { type ProviderRegistryEntry } from "./types.js";

/**
 * PagerDuty v3 webhook subscriptions sign with `X-PagerDuty-Signature: v1=<hex>`, an HMAC-SHA256 of
 * the raw request body only (no timestamp component in the signed string), which does not match any
 * of our presets (stripe needs a `t=` timestamp folded into the signing input, github's header name
 * and svix/square/discord's schemes are all different). Shipping sample-only until a custom verifier
 * config exists for this wire format.
 */
export const entry: ProviderRegistryEntry = {
  id: "pagerduty",
  label: "PagerDuty",
  category: "observability",
  docsUrl: "https://developer.pagerduty.com/docs/webhooks/webhook-signatures/",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "event.event_type" },
  sampleSource: "handauthored",
};
