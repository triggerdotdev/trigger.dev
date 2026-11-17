import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "zoom",
  label: "Zoom",
  category: "communication",
  docsUrl: "https://developers.zoom.us/docs/api/webhooks/",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "event" },
  sampleSource: "handauthored",
};
