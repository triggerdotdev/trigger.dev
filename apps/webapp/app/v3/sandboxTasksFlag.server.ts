import { FEATURE_FLAG, FeatureFlagCatalog, isPlainFlagObject } from "~/v3/featureFlags";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";

export function sandboxTasksEnabled(orgFeatureFlags: unknown): boolean {
  return flagEnabled(orgFeatureFlags, FEATURE_FLAG.sandboxTasks);
}

export function namedMachinesEnabled(orgFeatureFlags: unknown): boolean {
  return flagEnabled(orgFeatureFlags, FEATURE_FLAG.namedMachines);
}

/** Org override wins in both directions; otherwise the global flag; otherwise off. */
function flagEnabled(
  orgFeatureFlags: unknown,
  flag: typeof FEATURE_FLAG.sandboxTasks | typeof FEATURE_FLAG.namedMachines
): boolean {
  const override = FeatureFlagCatalog[flag].safeParse(
    isPlainFlagObject(orgFeatureFlags) ? orgFeatureFlags[flag] : undefined
  );
  if (override.success) return override.data;

  return globalFlagsRegistry.current()?.[flag] ?? false;
}
