import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "github",
  label: "GitHub",
  category: "source-control",
  docsUrl: "https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries",
  preset: "github",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "header", name: "x-github-event" },
  sampleSource: "hookdeck",
};
