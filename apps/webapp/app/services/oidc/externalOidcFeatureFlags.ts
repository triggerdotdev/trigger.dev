import { FeatureFlagCatalog, isPlainFlagObject } from "~/v3/featureFlags";

export function resolveExternalOidcFlags(
  globalFlags: Partial<FeatureFlagCatalog>,
  orgFeatureFlags: unknown
): { externalOidc: boolean } {
  const override = FeatureFlagCatalog.externalOidc.safeParse(
    isPlainFlagObject(orgFeatureFlags) ? orgFeatureFlags.externalOidc : undefined
  );
  return {
    externalOidc: override.success ? override.data : (globalFlags.externalOidc ?? false),
  };
}
