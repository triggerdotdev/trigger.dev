import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "woocommerce",
  label: "WooCommerce",
  category: "commerce",
  docsUrl: "https://woocommerce.com/document/webhooks/",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "header", name: "x-wc-webhook-topic" },
  sampleSource: "hookdeck",
};
