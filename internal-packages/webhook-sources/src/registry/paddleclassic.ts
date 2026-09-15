import { type ProviderRegistryEntry } from "./types.js";

export const entry: ProviderRegistryEntry = {
  id: "paddleclassic",
  label: "Paddle Classic",
  category: "billing",
  docsUrl: "https://developer.paddle.com/classic/reference/ZG9jOjI1MzUzOTg2-verifying-webhooks",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "alert_name" },
  sampleSource: "hookdeck",
};
