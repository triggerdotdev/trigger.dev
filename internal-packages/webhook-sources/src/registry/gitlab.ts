import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "gitlab",
  label: "GitLab",
  category: "source-control",
  docsUrl: "https://docs.gitlab.com/user/project/integrations/webhooks/",
  preset: "svix",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "header", name: "x-gitlab-event" },
  sampleSource: "hookdeck",
};
