import { z } from "zod";

export const FEATURE_FLAG = {
  defaultWorkerInstanceGroupId: "defaultWorkerInstanceGroupId",
  taskEventRepository: "taskEventRepository",
  hasQueryAccess: "hasQueryAccess",
  hasLogsPageAccess: "hasLogsPageAccess",
  hasAiAccess: "hasAiAccess",
  hasComputeAccess: "hasComputeAccess",
  hasPrivateConnections: "hasPrivateConnections",
  hasSso: "hasSso",
  mollifierEnabled: "mollifierEnabled",
  workerQueueScheduledSplitEnabled: "workerQueueScheduledSplitEnabled",
  realtimeBackend: "realtimeBackend",
  computeMigrationEnabled: "computeMigrationEnabled",
  computeMigrationFreePercentage: "computeMigrationFreePercentage",
  computeMigrationPaidPercentage: "computeMigrationPaidPercentage",
  computeMigrationRequireTemplate: "computeMigrationRequireTemplate",
  runTableV2: "runTableV2",
} as const;

export const FeatureFlagCatalog = {
  [FEATURE_FLAG.defaultWorkerInstanceGroupId]: z.string(),
  [FEATURE_FLAG.taskEventRepository]: z.enum(["clickhouse", "clickhouse_v2", "postgres"]),
  [FEATURE_FLAG.hasQueryAccess]: z.coerce.boolean(),
  [FEATURE_FLAG.hasLogsPageAccess]: z.coerce.boolean(),
  [FEATURE_FLAG.hasAiAccess]: z.coerce.boolean(),
  [FEATURE_FLAG.hasComputeAccess]: z.coerce.boolean(),
  [FEATURE_FLAG.hasPrivateConnections]: z.coerce.boolean(),
  [FEATURE_FLAG.hasSso]: z.coerce.boolean(),
  [FEATURE_FLAG.mollifierEnabled]: z.coerce.boolean(),
  [FEATURE_FLAG.workerQueueScheduledSplitEnabled]: z.coerce.boolean(),
  // Which backend serves the realtime run feed. Controllable
  // globally and per-org (org wins). Defaults to "electric" when unset.
  // "shadow" serves Electric but diffs the native path in the background.
  [FEATURE_FLAG.realtimeBackend]: z.enum(["electric", "native", "shadow"]),
  // Strict z.boolean() (not z.coerce.boolean()): coercion turns the string "false"
  // into true, which would silently flip this kill switch / per-org exclude the wrong
  // way if written as a string via the admin PAT route. The admin toggle sends a real
  // boolean, so this only rejects the dangerous stringified case.
  [FEATURE_FLAG.computeMigrationEnabled]: z.boolean(),
  [FEATURE_FLAG.computeMigrationFreePercentage]: z.coerce.number().int().min(0).max(100),
  [FEATURE_FLAG.computeMigrationPaidPercentage]: z.coerce.number().int().min(0).max(100),
  // When on, migrated orgs build their compute template in required mode at deploy
  // (fails the deploy on error) instead of shadow. Strict boolean (see above).
  [FEATURE_FLAG.computeMigrationRequireTemplate]: z.boolean(),
  // Per-org cutover to the parallel task_run_v2 table. When on, new runs for the
  // org mint a KSUID id (routing them to task_run_v2); off (the default) keeps
  // minting legacy ids. Strict boolean (see above): coercing a stringified
  // "false" to true would cut an org over by mistake, and runs created on v2
  // stay on v2.
  [FEATURE_FLAG.runTableV2]: z.boolean(),
};

export type FeatureFlagKey = keyof typeof FeatureFlagCatalog;

// Infrastructure flags that are read-only on the global flags page.
// Shown with current/resolved value but no controls.
export const GLOBAL_LOCKED_FLAGS: FeatureFlagKey[] = [
  FEATURE_FLAG.defaultWorkerInstanceGroupId,
  FEATURE_FLAG.taskEventRepository,
  // runTableV2 is resolved per-org only (`shouldUseV2RunTable` reads
  // `Organization.featureFlags`, never the global FeatureFlag table), so a
  // global toggle would be a silent no-op. Lock it on the global page to
  // avoid that footgun; per-org control stays on the org dialog.
  FEATURE_FLAG.runTableV2,
];

// Flags that are read-only on the org-level dialog.
// Shown with global value but no controls (org can't override these).
export const ORG_LOCKED_FLAGS: FeatureFlagKey[] = [
  FEATURE_FLAG.defaultWorkerInstanceGroupId,
  FEATURE_FLAG.taskEventRepository,
];

// Create a Zod schema from the existing catalog
export const FeatureFlagCatalogSchema = z.object(FeatureFlagCatalog);
export type FeatureFlagCatalog = z.infer<typeof FeatureFlagCatalogSchema>;

// Utility function to validate a feature flag value
export function validateFeatureFlagValue<T extends FeatureFlagKey>(
  key: T,
  value: unknown
): z.SafeParseReturnType<unknown, z.infer<(typeof FeatureFlagCatalog)[T]>> {
  return FeatureFlagCatalog[key].safeParse(value);
}

// Utility function to validate all feature flags at once
export function validateAllFeatureFlags(values: Record<string, unknown>) {
  return FeatureFlagCatalogSchema.safeParse(values);
}

// Utility function to validate partial feature flags (all keys optional)
export function validatePartialFeatureFlags(values: Record<string, unknown>) {
  return FeatureFlagCatalogSchema.partial().safeParse(values);
}

/**
 * Cross-field invariant on a RESOLVED org flag set: `runTableV2` may only be on
 * when the org's `realtimeBackend` is "native".
 *
 * New v2 runs mint a KSUID id (routing them to task_run_v2) and are only
 * observable in realtime on the native backend; Electric is bound to
 * public."TaskRun", so a v2 run minted while the org is still on Electric is
 * invisible in realtime. `shouldUseV2RunTable` already enforces this at read
 * time, but this guard blocks the dangerous combination at WRITE time so it can
 * never be configured, including the enable-race where `runTableV2` is flipped
 * on before `realtimeBackend=native` has propagated past the realtime cache.
 *
 * Pass the FINAL resolved set (after any merge) so it also rejects turning
 * `realtimeBackend` off/to "electric" while `runTableV2` is still on.
 */
export function validateFeatureFlagInvariants(
  flags: Record<string, unknown>
): { ok: true } | { ok: false; error: string } {
  const runTableV2 = FeatureFlagCatalog[FEATURE_FLAG.runTableV2].safeParse(
    flags[FEATURE_FLAG.runTableV2]
  );
  if (!(runTableV2.success && runTableV2.data === true)) {
    return { ok: true };
  }

  const backend = FeatureFlagCatalog[FEATURE_FLAG.realtimeBackend].safeParse(
    flags[FEATURE_FLAG.realtimeBackend]
  );
  if (backend.success && backend.data === "native") {
    return { ok: true };
  }

  return {
    ok: false,
    error:
      'runTableV2 can only be enabled when realtimeBackend is "native". Set realtimeBackend="native" first (and let it propagate past the realtime cache), then enable runTableV2.',
  };
}

// Utility types for catalog-driven UI rendering
export type FlagControlType =
  | { type: "boolean" }
  | { type: "enum"; options: string[] }
  | { type: "number"; min?: number; max?: number }
  | { type: "string" };

export function getFlagControlType(schema: z.ZodTypeAny): FlagControlType {
  const typeName = schema._def.typeName;

  if (typeName === "ZodBoolean") {
    return { type: "boolean" };
  }

  if (typeName === "ZodEnum") {
    return { type: "enum", options: schema._def.values as string[] };
  }

  // z.coerce.number() reports as ZodNumber; pull min/max out of its checks
  // so the UI can render a constrained number input instead of free text.
  if (typeName === "ZodNumber") {
    const checks = (schema._def.checks ?? []) as Array<{ kind: string; value?: number }>;
    const min = checks.find((c) => c.kind === "min")?.value;
    const max = checks.find((c) => c.kind === "max")?.value;
    return { type: "number", min, max };
  }

  return { type: "string" };
}

export function getAllFlagControlTypes(): Record<string, FlagControlType> {
  const result: Record<string, FlagControlType> = {};
  for (const [key, schema] of Object.entries(FeatureFlagCatalog)) {
    result[key] = getFlagControlType(schema);
  }
  return result;
}
