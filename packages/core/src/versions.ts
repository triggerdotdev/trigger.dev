export const API_VERSIONS = {
  LAZY_LOADED_CACHED_TASKS: "2023-09-29",
  SERIALIZED_TASK_OUTPUT: "2023-11-01",
} as const;

export const PLATFORM_FEATURES = {
  yieldExecution: API_VERSIONS.LAZY_LOADED_CACHED_TASKS,
  lazyLoadedCachedTasks: API_VERSIONS.LAZY_LOADED_CACHED_TASKS,
};

export function supportsFeature<TFeatureName extends keyof typeof PLATFORM_FEATURES>(
  featureName: TFeatureName,
  version: string
): boolean {
  if (version === "unversioned" || version === "unknown") {
    return false;
  }

  const supportedVersion = PLATFORM_FEATURES[featureName];

  if (!supportedVersion) {
    return false;
  }

  return version >= supportedVersion;
}
