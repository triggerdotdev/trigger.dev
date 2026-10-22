import { type ProviderRegistryEntry } from "./types.js";

/**
 * Infisical signs project webhooks with an `x-infisical-signature: t=<epoch ms>;<hex>` header (a
 * semicolon separates the two parts, and the signature has no `v1=` label). The signature is a
 * hex-encoded HMAC-SHA256 of the raw JSON body alone (no timestamp prefix), keyed by the optional
 * secret key the integrator types in when creating the webhook, used as UTF-8. The same millisecond
 * timestamp appears as the body's top-level `timestamp` field, so the signed bytes cover it. No
 * tolerance is documented, and there is no delivery or event id in the headers or body. The event
 * name rides the top-level `event` field.
 */
export const entry: ProviderRegistryEntry = {
  id: "infisical",
  label: "Infisical",
  category: "hosting-infra",
  docsUrl: "https://infisical.com/docs/documentation/platform/webhooks",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "event" },
  sampleSource: "handauthored",
};
