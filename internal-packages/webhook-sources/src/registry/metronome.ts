import { type ProviderRegistryEntry } from "./types.js";

/**
 * Metronome signs webhooks with a `Metronome-Webhook-Signature` header carrying a bare hex-encoded
 * HMAC-SHA256, keyed by the webhook's secret (used as UTF-8), over the `X-Metronome-Date` header value
 * (an RFC 1123 HTTP date such as `Mon, 02 Jan 2006 22:04:05 GMT`), a newline, and the raw body. The same
 * value also rides the standard `Date` header, which Metronome still accepts but advises against since
 * proxies may rewrite it. Requests older than five minutes should be ignored, and the body's top-level
 * `id` is the dedupe key. The event type rides the top-level `type` field in every payload.
 */
export const entry: ProviderRegistryEntry = {
  id: "metronome",
  label: "Metronome",
  category: "billing",
  docsUrl: "https://docs.metronome.com/guides/platform-configuration/setup-webhooks",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
