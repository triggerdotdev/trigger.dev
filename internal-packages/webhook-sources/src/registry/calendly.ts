import { type ProviderRegistryEntry } from "./types.js";

/**
 * Calendly signs with its own `Calendly-Webhook-Signature` header (`t=<ts>,v1=<hex>`, HMAC-SHA256 over
 * `{t}.{rawBody}`), not `stripe-signature`. The scheme matches our stripe preset's math but not its wire
 * format (header name), so no preset is set here; ships sample-only.
 */
export const entry: ProviderRegistryEntry = {
  id: "calendly",
  label: "Calendly",
  category: "calendar-scheduling",
  docsUrl: "https://developer.calendly.com/api-docs/4c305798a61d3-webhook-signatures",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "event" },
  sampleSource: "handauthored",
};
