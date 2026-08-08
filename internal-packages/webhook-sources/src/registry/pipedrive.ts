import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "pipedrive",
  label: "Pipedrive",
  category: "crm",
  docsUrl: "https://developers.pipedrive.com/docs/api/v1/Webhooks",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "event" },
  sampleSource: "hookdeck",
};
