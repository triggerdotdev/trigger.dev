import { type ProviderRegistryEntry } from "./types.js";

/**
 * Anthropic (Managed Agents) webhooks. Every delivery carries a single `X-Webhook-Signature`
 * header over a `whsec_`-prefixed secret — not the three-header Standard Webhooks scheme
 * (`webhook-id`/`webhook-timestamp`/`webhook-signature`) our `svix` preset verifies, so no
 * preset is set here. The discriminant lives at `data.type`; the top-level `type` is always
 * the literal string `"event"`.
 */
export const entry: ProviderRegistryEntry = {
  id: "anthropic",
  label: "Anthropic (Claude)",
  category: "ai-platform",
  docsUrl: "https://platform.claude.com/docs/en/managed-agents/webhooks",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "data.type" },
  sampleSource: "handauthored",
};
