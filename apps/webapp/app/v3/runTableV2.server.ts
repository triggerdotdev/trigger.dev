import { FEATURE_FLAG, FeatureFlagCatalog } from "~/v3/featureFlags";

/**
 * Per-org cutover switch for the parallel `task_run_v2` run table.
 *
 * Read in memory from `Organization.featureFlags` (already loaded on the
 * AuthenticatedEnvironment at API-key auth, so this adds no DB query) at the
 * single run-id mint site in the trigger path. On → mint a KSUID id, which
 * routes the run to `task_run_v2`; off (the default) → mint a legacy id, which
 * routes to `TaskRun`.
 *
 * RunStore never reads this flag: it routes purely by id format. The flag only
 * decides which id scheme is minted upstream. Disabling it sends only NEW runs
 * back to legacy; runs already created on v2 stay readable there (routed by id).
 */
export function shouldUseV2RunTable(orgFeatureFlags: unknown): boolean {
  if (orgFeatureFlags === null || typeof orgFeatureFlags !== "object") {
    return false;
  }

  const override = (orgFeatureFlags as Record<string, unknown>)[FEATURE_FLAG.runTableV2];
  if (override === undefined) {
    return false;
  }

  const parsed = FeatureFlagCatalog[FEATURE_FLAG.runTableV2].safeParse(override);
  return parsed.success ? parsed.data : false;
}
