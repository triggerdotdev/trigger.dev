import { type ProviderRegistryEntry } from "./types.js";

/**
 * Telegram authenticates webhooks with a static shared secret compared against the
 * X-Telegram-Bot-Api-Secret-Token header (set via the `secret_token` param to `setWebhook`), not an
 * HMAC/Ed25519 signature, so no preset applies. The Update object has no single `type` field: the
 * event kind is whichever top-level key is present (message, edited_message, callback_query,
 * inline_query, ...). `eventTypeSource.path` names the most common case as a representative default;
 * a real consumer needs to check for whichever of the known Update keys exists.
 */
export const entry: ProviderRegistryEntry = {
  id: "telegram",
  label: "Telegram",
  category: "communication",
  docsUrl: "https://core.telegram.org/bots/api#setwebhook",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "message" },
  sampleSource: "handauthored",
};
