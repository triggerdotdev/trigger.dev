import { FEATURE_FLAG, FeatureFlagCatalog } from "~/v3/featureFlags";

export type ShouldUseV2RunTableOptions = {
  /**
   * Whether the native realtime backend is enabled for this deployment
   * (`env.REALTIME_BACKEND_NATIVE_ENABLED === "1"`). Passed in rather than read
   * from env here so this stays a pure, env-free function the caller can
   * unit-test directly.
   */
  nativeRealtimeEnabled: boolean;
};

/**
 * Per-org cutover switch for the parallel `task_run_v2` run table.
 *
 * Read in memory from `Organization.featureFlags` (already loaded on the
 * AuthenticatedEnvironment at API-key auth, so this adds no DB query) at the
 * single run-id mint site in the trigger path. On → mint a KSUID id, which
 * routes the run to `task_run_v2`; off (the default) → mint a legacy id, which
 * routes to `TaskRun`.
 *
 * GATED ON NATIVE REALTIME. The Electric realtime backend serves shapes bound
 * to a single table (`TaskRun`) and is being retired; only the native backend
 * is table-agnostic and can observe a `task_run_v2` run in realtime
 * (subscribeToRun / useRealtimeRun / poll). Routing a run to v2 while the org is
 * still served by Electric would make that run silently invisible in realtime,
 * so v2 requires BOTH the deployment master switch (`nativeRealtimeEnabled`) and
 * the org's `realtimeBackend` flag set to "native". This is a temporary
 * coupling: once Electric is removed and native is the only/default backend,
 * drop the native check.
 *
 * RunStore never reads this flag: it routes purely by id format. The flag only
 * decides which id scheme is minted upstream. Disabling it sends only NEW runs
 * back to legacy; runs already created on v2 stay readable there (routed by id).
 */
export function shouldUseV2RunTable(
  orgFeatureFlags: unknown,
  options: ShouldUseV2RunTableOptions
): boolean {
  if (orgFeatureFlags === null || typeof orgFeatureFlags !== "object") {
    return false;
  }
  const flags = orgFeatureFlags as Record<string, unknown>;

  // Native realtime is a hard prerequisite (see doc comment): a v2 run is only
  // observable in realtime on the native backend.
  if (!options.nativeRealtimeEnabled) {
    return false;
  }
  const backend = FeatureFlagCatalog[FEATURE_FLAG.realtimeBackend].safeParse(
    flags[FEATURE_FLAG.realtimeBackend]
  );
  if (!(backend.success && backend.data === "native")) {
    return false;
  }

  const override = flags[FEATURE_FLAG.runTableV2];
  if (override === undefined) {
    return false;
  }
  const parsed = FeatureFlagCatalog[FEATURE_FLAG.runTableV2].safeParse(override);
  return parsed.success ? parsed.data : false;
}
