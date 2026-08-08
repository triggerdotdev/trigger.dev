import { type ProviderRegistryEntry } from "./types.js";

/**
 * Twilio signs webhooks with `X-Twilio-Signature`: HMAC-SHA1, base64-encoded, over the exact webhook
 * URL with sorted POST param names+values appended (JSON bodies instead append a `bodySHA256` query
 * param). No preset matches (SHA-1, not SHA-256; URL+params, not a raw-body or `t.body` string), so this
 * ships sample-only. Bodies are `application/x-www-form-urlencoded`, not JSON; every sample is the
 * decoded key/value form object. Twilio has no single "type" field across products: inbound SMS/MMS
 * carries a constant `SmsStatus` ("received"), while voice call requests carry `CallStatus`, which does
 * vary (ringing/completed/busy/no-answer/...). `eventTypeSource` points at `CallStatus` as the closest
 * real, varying discriminant; each sample's explicit `eventType` is the authoritative label.
 */
export const entry: ProviderRegistryEntry = {
  id: "twilio",
  label: "Twilio",
  category: "communication",
  docsUrl: "https://www.twilio.com/docs/usage/webhooks/webhooks-security",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "CallStatus" },
  sampleSource: "handauthored",
};
