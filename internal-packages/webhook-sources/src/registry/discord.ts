import { type ProviderRegistryEntry } from "./types.js";

/**
 * Discord Webhook Events. Verified against docs: two headers (`X-Signature-Ed25519` +
 * `X-Signature-Timestamp`), Ed25519 over `{timestamp}{rawBody}` - exact match for our `discord`
 * preset. The outer `type` field is only a wrapper (`0` = PING, `1` = event) and is NOT a useful
 * discriminant; the real event kind lives at `event.type` (e.g. `APPLICATION_AUTHORIZED`), so
 * `eventTypeSource` points there instead of the literal top-level `type` path.
 */
export const entry: ProviderRegistryEntry = {
  id: "discord",
  label: "Discord",
  category: "communication",
  docsUrl: "https://docs.discord.com/developers/events/webhook-events",
  preset: "discord",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "event.type" },
  sampleSource: "handauthored",
};
