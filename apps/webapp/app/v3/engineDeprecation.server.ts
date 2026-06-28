import { env } from "~/env.server";

/**
 * Graceful sunset of the v3 engine (RunEngineVersion.V1).
 *
 * v3 maps to engine V1 (MarQS + Graphile); v4 is engine V2 (run-engine). A
 * single master flag (DEPRECATE_V3_ENABLED, default off) gates every shutdown
 * behaviour so the cloud can flip the switch while self-hosted instances still
 * on V1 keep working until they migrate. This mirrors
 * DEPRECATE_V3_CLI_DEPLOYS_ENABLED, which already gates deploys.
 *
 * The flag controls three surfaces:
 *   1. Triggers that resolve to V1 are rejected with a graceful error.
 *   2. The legacy `trigger dev` websocket (v3 CLIs only) is closed.
 *   3. V1 run-lifecycle background jobs become no-ops to shed database load.
 *
 * Every call site also checks the run/project is actually V1, so v4 (V2) is
 * never affected.
 */

export const V3_MIGRATION_URL = "https://trigger.dev/docs/migrating-from-v3";

export const V3_TRIGGER_DEPRECATION_MESSAGE = `Trigger.dev v3 is no longer supported. Please upgrade your project to v4 to keep triggering tasks: ${V3_MIGRATION_URL}`;

// Sent as a websocket close reason, which is capped at 123 bytes, so keep it short.
export const V3_DEV_DEPRECATION_MESSAGE = `Trigger.dev v3 is no longer supported. Upgrade to v4: ${V3_MIGRATION_URL}`;

/**
 * Whether the v3 (engine V1) shutdown is being enforced. Guard every V1-only
 * code path with `isV3Disabled() && <run/project is V1>` so v4 is untouched.
 */
export function isV3Disabled(): boolean {
  return env.DEPRECATE_V3_ENABLED === "1";
}
