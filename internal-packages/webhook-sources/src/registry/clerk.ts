import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "clerk",
  label: "Clerk",
  category: "auth-identity",
  docsUrl: "https://clerk.com/docs/integrations/webhooks/overview",
  preset: "svix",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
