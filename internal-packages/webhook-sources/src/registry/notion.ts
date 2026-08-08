import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "notion",
  label: "Notion",
  category: "productivity",
  docsUrl: "https://developers.notion.com/reference/webhooks",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
