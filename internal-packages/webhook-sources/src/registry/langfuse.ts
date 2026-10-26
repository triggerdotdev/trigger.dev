import { type ProviderRegistryEntry } from "./types.js";

/**
 * Langfuse signs webhooks with an `x-langfuse-signature: t=<unix seconds>,v1=<hex>` header. The `v1`
 * value is a hex-encoded HMAC-SHA256 of `{t}.{raw body}`, keyed by the full secret string Langfuse
 * issues when the webhook is created (`lf-whsec_` plus 64 hex characters, used as UTF-8 including the
 * prefix). Langfuse documents no timestamp tolerance. Every envelope carries a top-level `type`
 * (`prompt-version`, `monitor-alert` or `project-notification`), `apiVersion: "v1"` and an `id` that
 * is the automation execution id, which is stable across retries of one delivery and serves for
 * idempotency. Prompt-version events add a top-level `action` (created/updated/deleted).
 */
export const entry: ProviderRegistryEntry = {
  id: "langfuse",
  label: "Langfuse",
  category: "ai-platform",
  docsUrl: "https://langfuse.com/docs/prompt-management/features/webhooks-slack-integrations",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
