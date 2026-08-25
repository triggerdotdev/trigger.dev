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

  const mode = requested[FEATURE_FLAG.snapshotStoreMode];
  if (typeof mode === "string" && mode !== "off") {
    return `Cannot set ${FEATURE_FLAG.snapshotStoreMode} to "${mode}": RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST is not configured in this deployment, so the snapshot store is never constructed and the flag would have no effect.`;
  }

  return undefined;
}
