import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "hubspot",
  label: "HubSpot",
  category: "crm",
  docsUrl: "https://developers.hubspot.com/docs/guides/api/app-management/webhooks",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "0.subscriptionType" },
  sampleSource: "hookdeck",
};
