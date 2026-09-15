import { type ProviderRegistryEntry } from "./types.js";

/**
 * WorkOS signs webhooks with a `WorkOS-Signature` header formatted as `t=<ms>,v1=<hex>`, HMAC-SHA256
 * over `{t}.{rawBody}`. That scheme matches our `stripe` preset's algorithm but not its header name
 * (`stripe-signature`), so this ships sample-only until a custom verifier config exists for it.
 */
export const entry: ProviderRegistryEntry = {
  id: "workos",
  label: "WorkOS",
  category: "auth-identity",
  docsUrl: "https://workos.com/docs/events/data-syncing/webhooks",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "event" },
  sampleSource: "handauthored",
};
