import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "paypal",
  label: "PayPal",
  category: "payments",
  docsUrl: "https://developer.paypal.com/api/rest/webhooks/rest/",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "event_type" },
  sampleSource: "hookdeck",
};
