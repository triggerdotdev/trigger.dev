// User-facing deprecation messages returned when a retired v3 (engine V1) SDK/CLI
// still triggers, reschedules, or opens the legacy dev websocket.

export const V3_MIGRATION_URL = "https://trigger.dev/docs/migrating-from-v3";

export const V3_TRIGGER_DEPRECATION_MESSAGE = `Trigger.dev v3 is no longer supported. Please upgrade your project to v4 to keep triggering tasks: ${V3_MIGRATION_URL}`;

// Sent as a websocket close reason, which is capped at 123 bytes, so keep it short.
export const V3_DEV_DEPRECATION_MESSAGE = `Trigger.dev v3 is no longer supported. Upgrade to v4: ${V3_MIGRATION_URL}`;
