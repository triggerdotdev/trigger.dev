import { FEATURE_FLAG, FeatureFlagCatalog, isPlainFlagObject } from "~/v3/featureFlags";

/**
 * Org override only, like the secret proxy flag: sandbox tasks still have known isolation gaps,
 * so a global default must never enable them for every organization.
 */
export function sandboxTasksEnabled(orgFeatureFlags: unknown): boolean {
  const override = FeatureFlagCatalog[FEATURE_FLAG.sandboxTasks].safeParse(
    isPlainFlagObject(orgFeatureFlags) ? orgFeatureFlags[FEATURE_FLAG.sandboxTasks] : undefined
  );
  return override.success && override.data;
}
