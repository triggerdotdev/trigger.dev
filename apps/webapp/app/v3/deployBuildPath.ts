import type {
  DeployBuildPath,
  DeployBuildPathSource,
  GetDeploySettingsResponseBody,
  RuntimeEnvironmentType,
} from "@trigger.dev/core/v3";
import { FEATURE_FLAG, FeatureFlagCatalog, type FeatureFlagKey } from "./featureFlags";
import type { BuildSettings } from "./buildSettings";

const ENV_TYPE_FLAG: Partial<Record<RuntimeEnvironmentType, FeatureFlagKey>> = {
  PREVIEW: FEATURE_FLAG.deployBuildPathPreview,
  STAGING: FEATURE_FLAG.deployBuildPathStaging,
  PRODUCTION: FEATURE_FLAG.deployBuildPathProduction,
};

export type ResolveDeployBuildPathInput = {
  environmentType: RuntimeEnvironmentType;
  orgFeatureFlags: unknown;
  globalFlags: Record<string, unknown> | undefined;
  projectBuildSettings: BuildSettings | null | undefined;
  nativeBuildServerAvailable: boolean;
};

/**
 * Precedence, first hit wins: native unavailable on this install → project opt-out →
 * org[env type] → org → global[env type] → global → depot. Values that fail the catalog
 * schema are skipped rather than treated as depot, matching `flag()`.
 */
export function resolveDeployBuildPath(
  input: ResolveDeployBuildPathInput
): GetDeploySettingsResponseBody["build"] {
  if (!input.nativeBuildServerAvailable) {
    return { path: "depot", source: "unavailable" };
  }

  if (input.projectBuildSettings?.disableNativeBuildServer === true) {
    return { path: "depot", source: "project_opt_out" };
  }

  const envKey = ENV_TYPE_FLAG[input.environmentType];
  const org = asRecord(input.orgFeatureFlags);
  const global = input.globalFlags ?? {};

  const candidates: Array<
    [Record<string, unknown>, FeatureFlagKey | undefined, DeployBuildPathSource]
  > = [
    [org, envKey, "organization_environment"],
    [org, FEATURE_FLAG.deployBuildPath, "organization"],
    [global, envKey, "global_environment"],
    [global, FEATURE_FLAG.deployBuildPath, "global"],
  ];

  for (const [flags, key, source] of candidates) {
    if (!key) continue;
    const path = readBuildPath(flags, key);
    if (path) return { path, source };
  }

  return { path: "depot", source: "default" };
}

function readBuildPath(
  flags: Record<string, unknown>,
  key: FeatureFlagKey
): DeployBuildPath | undefined {
  const value = flags[key];
  if (value === undefined || value === null) return undefined;
  const parsed = FeatureFlagCatalog[key].safeParse(value);
  return parsed.success ? (parsed.data as DeployBuildPath) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
