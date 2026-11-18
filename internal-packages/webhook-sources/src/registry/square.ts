import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "square",
  label: "Square",
  category: "payments",
  docsUrl: "https://developer.squareup.com/docs/webhooks/step3validate",
  preset: "square",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
