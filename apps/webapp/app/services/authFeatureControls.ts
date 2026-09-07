import { FEATURE_FLAG, type FeatureFlagCatalog } from "~/v3/featureFlags";

export type AuthFeatureControls = {
  additionalApiKeyLookupEnabled: boolean;
};

export function resolveAuthFeatureControls(
  flags: Partial<FeatureFlagCatalog> | Record<string, unknown> | undefined
): AuthFeatureControls {
  const additionalApiKeyLookupEnabled = flags?.[FEATURE_FLAG.additionalApiKeyLookupEnabled];

  return {
    additionalApiKeyLookupEnabled:
      additionalApiKeyLookupEnabled === undefined || additionalApiKeyLookupEnabled === true,
  };
}
