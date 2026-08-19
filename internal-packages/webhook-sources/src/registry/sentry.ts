import { type ProviderRegistryEntry } from "./types.js";

/**
 * Sentry signs Integration Platform webhooks with a custom HMAC-SHA256 scheme (Sentry-Hook-Signature
 * over the raw body, keyed by the integration's client secret) - it does not match stripe/github/svix/
 * square/discord, so this ships sample-only with no preset. The resource type (issue/error/comment/...)
 * rides the `Sentry-Hook-Resource` header rather than the body.
 */
export const entry: ProviderRegistryEntry = {
  id: "sentry",
  label: "Sentry",
  category: "observability",
  docsUrl: "https://docs.sentry.io/product/integrations/integration-platform/webhooks/",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "header", name: "sentry-hook-resource" },
  sampleSource: "handauthored",
};
