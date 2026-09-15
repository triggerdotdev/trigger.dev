import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "bigcommerce",
  label: "BigCommerce",
  category: "commerce",
  docsUrl: "https://developer.bigcommerce.com/docs/integrations/webhooks",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "scope" },
  sampleSource: "hookdeck",
};
