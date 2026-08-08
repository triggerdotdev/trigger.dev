import { type ProviderRegistryEntry } from "./types.js";

/**
 * Attio signs with its own `attio-signature` header (legacy alias `X-Attio-Signature`): a bare hex
 * HMAC-SHA256 digest of the raw body, no `sha256=` prefix, no timestamp component, no svix-style
 * id/timestamp/signature triple. That doesn't match our `github` preset's `sha256=<hex>` format, our
 * `stripe` preset's `t=,v1=` format, or `svix`'s header set, so this ships sample-only.
 */
export const entry: ProviderRegistryEntry = {
  id: "attio",
  label: "Attio",
  category: "crm",
  docsUrl: "https://docs.attio.com/rest-api/guides/webhooks",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "events.0.event_type" },
  sampleSource: "handauthored",
};
