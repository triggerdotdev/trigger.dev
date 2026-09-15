import { type ProviderRegistryEntry } from "./types.js";

/**
 * Recall.ai signs webhooks with Svix: Webhook-Id / Webhook-Timestamp / Webhook-Signature headers,
 * HMAC-SHA256 base64 over "{id}.{timestamp}.{body}", secret prefixed "whsec_". Matches our svix preset.
 */
export const entry: ProviderRegistryEntry = {
  id: "recall-ai",
  label: "Recall.ai",
  category: "ai-platform",
  docsUrl: "https://docs.recall.ai/docs/authenticating-requests-from-recallai",
  preset: "svix",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "event" },
  sampleSource: "handauthored",
};
