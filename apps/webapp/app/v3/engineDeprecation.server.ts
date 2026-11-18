// User-facing deprecation message returned when a retired v3 (engine V1) SDK/CLI
// still triggers or reschedules.

const V3_MIGRATION_URL = "https://trigger.dev/docs/migrating-from-v3";

export const V3_TRIGGER_DEPRECATION_MESSAGE = `Trigger.dev v3 is no longer supported. Please upgrade your project to v4 to keep triggering tasks: ${V3_MIGRATION_URL}`;
