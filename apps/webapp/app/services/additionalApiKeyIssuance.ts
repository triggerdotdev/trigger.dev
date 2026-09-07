import { FEATURE_FLAG, type FeatureFlagCatalog } from "~/v3/featureFlags";

export function resolveAdditionalApiKeyIssuance(
  globalFlags: Partial<FeatureFlagCatalog> | Record<string, unknown> | undefined,
  organizationFlags: Record<string, unknown> | undefined
): boolean {
  const issuanceEnabled = globalFlags?.[FEATURE_FLAG.additionalApiKeyIssuanceEnabled];
  if (issuanceEnabled !== undefined && issuanceEnabled !== true) {
    return false;
  }

  const organizationOverride = organizationFlags?.[FEATURE_FLAG.additionalApiKeysEnabled];
  if (organizationOverride === true || organizationOverride === false) {
    return organizationOverride;
  }

  const additionalApiKeysEnabled = globalFlags?.[FEATURE_FLAG.additionalApiKeysEnabled];
  return additionalApiKeysEnabled === undefined || additionalApiKeysEnabled === true;
}
