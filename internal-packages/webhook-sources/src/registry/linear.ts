import { type ProviderRegistryEntry } from "./types.js";

/**
 * Linear signs webhooks with a `Linear-Signature` header carrying a hex-encoded HMAC-SHA256 signature
 * of the raw body, keyed by the webhook's signing secret. The `linear` provider config in core carries
 * that scheme, so `webhooks.linear()` verifies every sample here and `@trigger.dev/linear` turns the
 * `AgentSessionEvent` samples into agent turns. The resource type rides the top-level `type` field in
 * the body, but the meaningful event also depends on the top-level `action` (create/update/remove, or
 * created/prompted for agent sessions).
 */
export const entry: ProviderRegistryEntry = {
  id: "linear",
  label: "Linear",
  category: "pm",
  docsUrl: "https://linear.app/developers/webhooks",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
