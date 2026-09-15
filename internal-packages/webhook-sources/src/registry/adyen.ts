import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "adyen",
  label: "Adyen",
  category: "payments",
  docsUrl: "https://docs.adyen.com/development-resources/webhooks/",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "notificationItems.0.NotificationRequestItem.eventCode" },
  sampleSource: "hookdeck",
};
