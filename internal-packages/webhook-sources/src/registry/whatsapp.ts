import { type ProviderRegistryEntry } from "./types.js";

/**
 * WhatsApp Cloud API (Meta). Signs with `X-Hub-Signature-256: sha256=<hex>` HMAC-SHA256 over the raw
 * body, matching our `github` preset exactly. Note: Meta's real payloads always carry
 * `entry[].changes[].field === "messages"` for both inbound messages AND status updates, so that
 * field cannot discriminate the two; the real discriminant is which key (`value.messages` vs
 * `value.statuses`) is present in the body. `eventTypeSource.path` below points at the field per the
 * FACTS hypothesis, but automated extraction from it will not distinguish message vs status types.
 */
export const entry: ProviderRegistryEntry = {
  id: "whatsapp",
  label: "WhatsApp (Meta)",
  category: "communication",
  docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/",
  preset: "github",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "entry.0.changes.0.field" },
  sampleSource: "handauthored",
};
