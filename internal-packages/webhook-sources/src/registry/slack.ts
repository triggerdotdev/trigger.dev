import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "slack",
  label: "Slack",
  category: "communication",
  docsUrl: "https://docs.slack.dev/authentication/verifying-requests-from-slack/",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "event.type" },
  sampleSource: "handauthored",
};
