import { FeatureFlagCatalog, FEATURE_FLAG, isPlainFlagObject } from "~/v3/featureFlags";
import { cachedFlag } from "~/v3/featureFlags.server";

export function isTrustedDeploysEnabled(orgFeatureFlags: unknown): Promise<boolean> {
  const override = FeatureFlagCatalog.trustedDeploysEnabled.safeParse(
    isPlainFlagObject(orgFeatureFlags) ? orgFeatureFlags.trustedDeploysEnabled : undefined
  );
  return override.success
    ? Promise.resolve(override.data)
    : cachedFlag({ key: FEATURE_FLAG.trustedDeploysEnabled, defaultValue: false });
}
