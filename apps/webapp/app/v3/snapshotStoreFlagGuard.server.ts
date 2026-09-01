import { FEATURE_FLAG } from "~/v3/featureFlags";

/**
 * Refuses a dial flip that would be silent: with no host the store is never constructed, so a flag
 * past `off` has no effect. Cannot live in validatePartialFeatureFlags, which client components
 * import and which therefore can never read env.
 */
export function snapshotStoreFlagSaveError(
  requested: Record<string, unknown>,
  opts: { redisHostConfigured: boolean; everEnabled?: boolean }
): string | undefined {
  // Both keys, because either one past `off` is equally silent without a connection, and either one
  // equally makes a run resident once there is one.
  const enabling = ([FEATURE_FLAG.snapshotStoreMode, FEATURE_FLAG.snapshotStoreOrgMode] as const)
    .map((key) => ({ key, value: requested[key] }))
    .filter(({ value }) => typeof value === "string" && value !== "off");

  if (!opts.redisHostConfigured) {
    for (const { key, value } of enabling) {
      return `Cannot set ${key} to "${String(value)}": RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST is not configured in this deployment, so the snapshot store is never constructed and the flag would have no effect.`;
    }
    return undefined;
  }

  // The latch must already be set before anything can become resident. Transitions skip Redis
  // entirely while it is unset, so a run born after the dial moved but before the latch landed would
  // be resident with its transitions skipped, and its head would freeze while Postgres moved on.
  // Refusing here makes that ordering impossible to get wrong rather than merely documented.
  if (opts.everEnabled === false) {
    for (const { key, value } of enabling) {
      return `Cannot set ${key} to "${String(value)}" before ${FEATURE_FLAG.snapshotStoreEverEnabled} is true. Set that flag first: until it is, transitions skip the store entirely, so a run born now would be resident with its transitions skipped and its head would freeze.`;
    }
  }

  return undefined;
}

/**
 * Refuses an organisation-only key on a global save. Nothing reads the global row for it, so a
 * value saved there is inert, and an inert control an operator can set is worse than no control.
 */
export function globalOnlySnapshotStoreFlagError(
  requested: Record<string, unknown>
): string | undefined {
  if (FEATURE_FLAG.snapshotStoreOrgMode in requested) {
    return `${FEATURE_FLAG.snapshotStoreOrgMode} is per-organisation only; nothing reads it from the global flags, so setting it here would have no effect.`;
  }
  return undefined;
}
