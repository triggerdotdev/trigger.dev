import { FEATURE_FLAG, type FeatureFlagCatalog } from "~/v3/featureFlags";

/**
 * Resolves whether the private Slack support channel is switched on for an org.
 *
 * A per-organization value wins over the global one in both directions, so a
 * single org can be enabled ahead of a global rollout, or excluded during one.
 * Absent everywhere means off — the feature depends on a plan entitlement and
 * Slack app scopes that ship separately, so defaulting on would surface a
 * button that cannot work.
 */
export function resolveSupportChannelEnabled(
  globalFlags: Partial<FeatureFlagCatalog> | Record<string, unknown> | undefined,
  organizationFlags: Record<string, unknown> | undefined
): boolean {
  const organizationOverride = organizationFlags?.[FEATURE_FLAG.supportChannelEnabled];
  if (organizationOverride === true || organizationOverride === false) {
    return organizationOverride;
  }

  return globalFlags?.[FEATURE_FLAG.supportChannelEnabled] === true;
}
