import { FEATURE_FLAG, FeatureFlagCatalog, isPlainFlagObject } from "~/v3/featureFlags";

export function sandboxTasksEnabled(orgFeatureFlags: unknown): boolean {
  const override = FeatureFlagCatalog[FEATURE_FLAG.sandboxTasks].safeParse(
    isPlainFlagObject(orgFeatureFlags) ? orgFeatureFlags[FEATURE_FLAG.sandboxTasks] : undefined
  );
  return override.success && override.data;
}
