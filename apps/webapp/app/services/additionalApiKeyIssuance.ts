import { FEATURE_FLAG, type FeatureFlagCatalog } from "~/v3/featureFlags";

export function resolveAdditionalApiKeyIssuance(
  globalFlags: Partial<FeatureFlagCatalog> | Record<string, unknown> | undefined,
  organizationFlags: Record<string, unknown> | undefined
): boolean {
  if (globalFlags?.[FEATURE_FLAG.additionalApiKeyIssuanceEnabled] !== true) {
    return false;
  }

  const organizationOverride = organizationFlags?.[FEATURE_FLAG.additionalApiKeysEnabled];
  if (organizationOverride === true || organizationOverride === false) {
    return organizationOverride;
  }

  return globalFlags?.[FEATURE_FLAG.additionalApiKeysEnabled] === true;
}
