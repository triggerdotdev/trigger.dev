import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "bitbucket",
  label: "Bitbucket",
  category: "source-control",
  docsUrl: "https://support.atlassian.com/bitbucket-cloud/docs/manage-webhooks/",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "header", name: "x-event-key" },
  sampleSource: "hookdeck",
};
