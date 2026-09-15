import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "openai",
  label: "OpenAI",
  category: "ai-platform",
  docsUrl: "https://platform.openai.com/docs/guides/webhooks",
  preset: "svix",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
