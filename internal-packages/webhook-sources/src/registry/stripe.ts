import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "stripe",
  label: "Stripe",
  category: "payments",
  docsUrl: "https://docs.stripe.com/webhooks",
  preset: "stripe",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "hookdeck",
};
