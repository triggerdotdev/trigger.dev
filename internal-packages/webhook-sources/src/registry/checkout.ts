import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "checkout",
  label: "Checkout.com",
  category: "payments",
  docsUrl: "https://www.checkout.com/docs/developer-resources/event-notifications/receive-webhooks",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "hookdeck",
};
