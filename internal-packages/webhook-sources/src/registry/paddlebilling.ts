import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "paddlebilling",
  label: "Paddle Billing",
  category: "billing",
  docsUrl: "https://developer.paddle.com/webhooks/overview",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "event_type" },
  sampleSource: "hookdeck",
};
