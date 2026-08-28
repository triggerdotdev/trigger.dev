import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "resend",
  label: "Resend",
  category: "email",
  docsUrl: "https://resend.com/docs/dashboard/webhooks/introduction",
  preset: "svix",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
