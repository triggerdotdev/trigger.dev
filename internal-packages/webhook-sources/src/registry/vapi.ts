import { type ProviderRegistryEntry } from "./types.js";

/**
 * Vapi signs server webhooks with a bespoke scheme: an `x-vapi-signature` header holding a raw
 * HMAC-SHA256 hex digest of the raw body, keyed by the integrator-configured server secret. There is
 * no timestamp component and no `sha256=`/base64 wrapping, so it does not match our
 * stripe/github/svix/square/discord presets - this ships sample-only. Every server message is wrapped
 * in a top-level `message` object whose `type` field is the event discriminant.
 */
export const entry: ProviderRegistryEntry = {
  id: "vapi",
  label: "Vapi",
  category: "voice",
  docsUrl: "https://docs.vapi.ai/server-url/server-authentication",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "message.type" },
  sampleSource: "handauthored",
};
