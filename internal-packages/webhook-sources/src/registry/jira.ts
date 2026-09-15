import { type ProviderRegistryEntry } from "./types.js";

/**
 * Jira Cloud signs webhooks with an `X-Hub-Signature` header (no `-256` suffix, value `sha256=<hex>`
 * per the WebSub convention), which does not match our `github` preset's `x-hub-signature-256` header
 * name. Shipping sample-only until a custom verifier config exists for this wire format.
 */
export const entry: ProviderRegistryEntry = {
  id: "jira",
  label: "Jira",
  category: "pm",
  docsUrl: "https://developer.atlassian.com/cloud/jira/platform/webhooks/",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "webhookEvent" },
  sampleSource: "handauthored",
};
