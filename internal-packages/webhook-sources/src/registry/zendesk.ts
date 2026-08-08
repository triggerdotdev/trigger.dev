import { type ProviderRegistryEntry } from "./types.js";

/**
 * Zendesk signs webhooks with an `X-Zendesk-Webhook-Signature` header: base64(HMAC-SHA256(timestamp +
 * body)), paired with an `X-Zendesk-Webhook-Timestamp` header carrying the timestamp. That
 * concatenated-no-separator scheme matches none of our presets (closest is `svix`, which needs a
 * dot-joined `{id}.{timestamp}.{body}` string and a `webhook-id` header Zendesk never sends), so this
 * ships sample-only.
 *
 * The request body has no fixed schema either: Zendesk triggers/automations send whatever JSON an
 * admin authors from content placeholders (e.g. `{{ticket.id}}`, `{{ticket.status}}`, rendered with
 * real values before delivery), so there is no universal discriminant field. `status` is the closest
 * ever-present, varying field across a common ticket-shaped body; each sample's own `eventType` is the
 * authoritative label regardless of what `status` holds.
 */
export const entry: ProviderRegistryEntry = {
  id: "zendesk",
  label: "Zendesk",
  category: "support",
  docsUrl: "https://developer.zendesk.com/documentation/webhooks/verifying/",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "status" },
  sampleSource: "handauthored",
};
