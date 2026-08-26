import { FEATURE_FLAG } from "~/v3/featureFlags";

/**
 * Refuses a dial flip that would be silent: with no host the store is never constructed, so a flag
 * past `off` has no effect. Cannot live in validatePartialFeatureFlags, which client components
 * import and which therefore can never read env.
 */
export function snapshotStoreFlagSaveError(
  requested: Record<string, unknown>,
  opts: { redisHostConfigured: boolean }
): string | undefined {
  if (opts.redisHostConfigured) {
    return undefined;
  }

  // Both keys, because either one past `off` is equally silent without a connection.
  for (const key of [FEATURE_FLAG.snapshotStoreMode, FEATURE_FLAG.snapshotStoreOrgMode] as const) {
    const value = requested[key];
    if (typeof value === "string" && value !== "off") {
      return `Cannot set ${key} to "${value}": RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST is not configured in this deployment, so the snapshot store is never constructed and the flag would have no effect.`;
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
