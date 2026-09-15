import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "shopify",
  label: "Shopify",
  category: "commerce",
  docsUrl: "https://shopify.dev/docs/apps/build/webhooks/verify-deliveries",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "header", name: "x-shopify-topic" },
  sampleSource: "hookdeck",
};
