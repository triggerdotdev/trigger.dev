import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "square",
  label: "Square",
  category: "payments",
  docsUrl: "https://developer.squareup.com/docs/webhooks/step3validate",
  preset: "square",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
