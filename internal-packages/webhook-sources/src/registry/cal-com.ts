import { type ProviderRegistryEntry } from "./types.js";

/**
 * Cal.com signs webhooks with an `x-cal-signature-256` header, a plain hex HMAC-SHA256 digest of
 * the raw JSON body (no `sha256=` prefix), so it does not match our `github` preset's wire format.
 * Ships sample-only. The discriminant is `triggerEvent` at the top level of the body.
 */
export const entry: ProviderRegistryEntry = {
  id: "cal-com",
  label: "Cal.com",
  category: "calendar-scheduling",
  docsUrl: "https://cal.com/docs/developing/guides/automation/webhooks",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "triggerEvent" },
  sampleSource: "handauthored",
};
