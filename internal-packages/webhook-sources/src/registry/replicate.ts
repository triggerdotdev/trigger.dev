import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "replicate",
  label: "Replicate",
  category: "ai-platform",
  docsUrl: "https://replicate.com/docs/topics/webhooks/verify-webhook",
  preset: "svix",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "status" },
  sampleSource: "handauthored",
};
