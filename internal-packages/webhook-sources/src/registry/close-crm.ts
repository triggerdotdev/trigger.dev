import { type ProviderRegistryEntry } from "./types.js";

/**
 * Close signs webhooks with a custom scheme: the `close-sig-hash` header carries a hex-encoded
 * HMAC-SHA256 signature computed over `{close-sig-timestamp}{rawBody}` (timestamp in a sibling
 * header, key hex-decoded before use). That doesn't match `stripe` (`t=,v1=` combined into one
 * header value), `square` (base64 digest), `github` (no timestamp component), `svix` (three
 * id/timestamp/signature headers, base64), or `discord` (Ed25519), so this ships sample-only with
 * no preset. The resource type rides the body's nested `event.object_type` plus `event.action`
 * (e.g. `lead` + `created`, `activity.note` + `created`); `event.action` is the primary
 * discriminant field.
 */
export const entry: ProviderRegistryEntry = {
  id: "close-crm",
  label: "Close",
  category: "crm",
  docsUrl: "https://developer.close.com/topics/webhooks/",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "event.action" },
  sampleSource: "handauthored",
};
