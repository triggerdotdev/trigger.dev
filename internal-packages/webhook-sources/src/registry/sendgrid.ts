import { type ProviderRegistryEntry } from "./types.js";

/**
 * SendGrid's Event Webhook is signed with ECDSA (a private/public EC key pair SendGrid generates):
 * `X-Twilio-Email-Event-Webhook-Signature` (base64 signature) and
 * `X-Twilio-Email-Event-Webhook-Timestamp` over `{timestamp}{rawBody}`. That scheme is not among our
 * stripe/github/svix/square/discord verifier presets, so this ships sample-only (no `preset`). SendGrid
 * also delivers events in a BATCH: the POST body is a JSON array of event objects, so the discriminant
 * lives at `0.event` (the first event in the array) rather than a top-level field.
 */
export const entry: ProviderRegistryEntry = {
  id: "sendgrid",
  label: "SendGrid",
  category: "email",
  docsUrl:
    "https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "0.event" },
  sampleSource: "handauthored",
};
