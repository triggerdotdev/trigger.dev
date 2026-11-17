import { FEATURE_FLAG, FeatureFlagCatalog, isPlainFlagObject } from "~/v3/featureFlags";

/**
 * Org override only. A global value is never read: a cold or flipped global cache must not turn
 * protection off for an org that already has proxy-only values.
 */
export function secretProxyEnabled(orgFeatureFlags: unknown): boolean {
  const override = FeatureFlagCatalog[FEATURE_FLAG.secretProxy].safeParse(
    isPlainFlagObject(orgFeatureFlags) ? orgFeatureFlags[FEATURE_FLAG.secretProxy] : undefined
  );
  return override.success && override.data;
}
