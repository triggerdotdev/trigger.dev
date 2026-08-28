import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "monday",
  label: "monday.com",
  category: "pm",
  docsUrl: "https://developer.monday.com/api-reference/docs/webhooks",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "event.type" },
  sampleSource: "hookdeck",
};
