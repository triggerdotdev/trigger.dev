import { type ProviderRegistryEntry } from "./types.js";

/**
 * Intercom signs webhook notifications with an HMAC-SHA1 digest in the `X-Hub-Signature` header
 * (over the raw body, keyed by the app's client secret) - that is SHA1, not the SHA256 our github
 * preset requires, so this ships sample-only with no preset. Every notification is wrapped in the
 * same envelope (`type: "notification_event"`, `topic`, `data.item`), with `topic` carrying the
 * event discriminant.
 */
export const entry: ProviderRegistryEntry = {
  id: "intercom",
  label: "Intercom",
  category: "support",
  docsUrl: "https://developers.intercom.com/docs/references/webhooks/webhook-models",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "topic" },
  sampleSource: "handauthored",
};
