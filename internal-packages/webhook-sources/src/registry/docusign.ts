import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "docusign",
  label: "DocuSign",
  category: "e-signature",
  docsUrl: "https://developers.docusign.com/platform/webhooks/connect/",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "event" },
  sampleSource: "handauthored",
};
