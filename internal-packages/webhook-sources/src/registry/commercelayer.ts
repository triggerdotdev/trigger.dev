import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "commercelayer",
  label: "Commerce Layer",
  category: "commerce",
  docsUrl: "https://docs.commercelayer.io/core/callbacks-security",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "data.type" },
  sampleSource: "hookdeck",
};
