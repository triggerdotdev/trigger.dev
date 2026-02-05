import { Result } from "neverthrow";
import { z } from "zod";

export const EnvSlugSchema = z.enum(["dev", "stg", "prod", "preview"]);
export type EnvSlug = z.infer<typeof EnvSlugSchema>;

export const ALL_ENV_SLUGS: EnvSlug[] = ["dev", "stg", "prod", "preview"];

const safeJsonParse = Result.fromThrowable(
  (val: string) => JSON.parse(val) as unknown,
  () => null
);

/**
 * Zod transform for form fields that submit JSON-encoded arrays.
 * Parses the string as JSON and returns the array, or null if invalid.
 */
export const jsonArrayField = z.string().optional().transform((val) => {
  if (!val) return null;
  return safeJsonParse(val).match(
    (parsed) => (Array.isArray(parsed) ? parsed : null),
    () => null
  );
});

export const VercelIntegrationConfigSchema = z.object({
  atomicBuilds: z.array(EnvSlugSchema).nullable().optional(),
  pullEnvVarsBeforeBuild: z.array(EnvSlugSchema).nullable().optional(),
  /** Maps a custom Vercel environment to Trigger.dev's staging environment. */
  vercelStagingEnvironment: z.object({
    environmentId: z.string(),
    displayName: z.string(),
  }).nullable().optional(),
  discoverEnvVars: z.array(EnvSlugSchema).nullable().optional(),
});

export type VercelIntegrationConfig = z.infer<typeof VercelIntegrationConfigSchema>;

export const TriggerEnvironmentType = z.enum(["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"]);
export type TriggerEnvironmentType = z.infer<typeof TriggerEnvironmentType>;

/**
 * Per-environment, per-variable sync settings.
 * Missing env slug = sync all vars. Missing var in env = sync by default.
 * Only explicitly `false` entries disable sync.
 */
export const SyncEnvVarsMappingSchema = z.record(EnvSlugSchema, z.record(z.string(), z.boolean())).default({});

export type SyncEnvVarsMapping = z.infer<typeof SyncEnvVarsMappingSchema>;

export const VercelProjectIntegrationDataSchema = z.object({
  config: VercelIntegrationConfigSchema,
  syncEnvVarsMapping: SyncEnvVarsMappingSchema,
  vercelProjectName: z.string(),
  vercelTeamId: z.string().nullable(),
  vercelProjectId: z.string(),
  onboardingCompleted: z.boolean().optional(),
});

export type VercelProjectIntegrationData = z.infer<typeof VercelProjectIntegrationDataSchema>;

export function createDefaultVercelIntegrationData(
  vercelProjectId: string,
  vercelProjectName: string,
  vercelTeamId: string | null
): VercelProjectIntegrationData {
  return {
    config: {
      atomicBuilds: ["prod"],
      pullEnvVarsBeforeBuild: ["prod", "stg", "preview"],
      discoverEnvVars: ["prod", "stg", "preview"],
      vercelStagingEnvironment: null,
    },
    syncEnvVarsMapping: {},
    vercelProjectId,
    vercelProjectName,
    vercelTeamId,
  };
}

/**
 * Maps a Trigger.dev environment type to its Vercel target identifier(s).
 * Returns null for STAGING when no custom environment is configured.
 */
export function envTypeToVercelTarget(
  envType: TriggerEnvironmentType,
  stagingEnvironmentId?: string | null
): string[] | null {
  switch (envType) {
    case "PRODUCTION":
      return ["production"];
    case "STAGING":
      return stagingEnvironmentId ? [stagingEnvironmentId] : null;
    case "PREVIEW":
      return ["preview"];
    case "DEVELOPMENT":
      return ["development"];
  }
}

export function getAvailableEnvSlugs(
  hasStagingEnvironment: boolean,
  hasPreviewEnvironment: boolean
): EnvSlug[] {
  return ALL_ENV_SLUGS.filter((s) => {
    if (s === "stg" && !hasStagingEnvironment) return false;
    if (s === "preview" && !hasPreviewEnvironment) return false;
    return true;
  });
}

export function getAvailableEnvSlugsForBuildSettings(
  hasStagingEnvironment: boolean,
  hasPreviewEnvironment: boolean
): EnvSlug[] {
  return getAvailableEnvSlugs(hasStagingEnvironment, hasPreviewEnvironment).filter((s) => s !== "dev");
}

export function isDiscoverEnvVarsEnabledForEnvironment(
  discoverEnvVars: EnvSlug[] | null | undefined,
  environmentType: TriggerEnvironmentType
): boolean {
  if (!discoverEnvVars || discoverEnvVars.length === 0) {
    return false;
  }
  const envSlug = envTypeToSlug(environmentType);
  return discoverEnvVars.includes(envSlug);
}

export function envTypeToSlug(environmentType: TriggerEnvironmentType): EnvSlug {
  switch (environmentType) {
    case "DEVELOPMENT":
      return "dev";
    case "STAGING":
      return "stg";
    case "PRODUCTION":
      return "prod";
    case "PREVIEW":
      return "preview";
  }
}

export function envSlugToType(slug: EnvSlug): TriggerEnvironmentType {
  switch (slug) {
    case "dev":
      return "DEVELOPMENT";
    case "stg":
      return "STAGING";
    case "prod":
      return "PRODUCTION";
    case "preview":
      return "PREVIEW";
  }
}

export function shouldSyncEnvVar(
  mapping: SyncEnvVarsMapping,
  envVarName: string,
  environmentType: TriggerEnvironmentType
): boolean {
  const envSlug = envTypeToSlug(environmentType);
  const envSettings = mapping[envSlug];
  if (!envSettings) {
    return true;
  }
  return envSettings[envVarName] !== false;
}

export function shouldSyncEnvVarForAnyEnvironment(
  mapping: SyncEnvVarsMapping,
  envVarName: string
): boolean {
  for (const slug of ALL_ENV_SLUGS) {
    const envSettings = mapping[slug];
    if (!envSettings) {
      return true;
    }
    if (envSettings[envVarName] !== false) {
      return true;
    }
  }

  return false;
}

export function isPullEnvVarsEnabledForEnvironment(
  pullEnvVarsBeforeBuild: EnvSlug[] | null | undefined,
  environmentType: TriggerEnvironmentType
): boolean {
  if (!pullEnvVarsBeforeBuild || pullEnvVarsBeforeBuild.length === 0) {
    return false;
  }
  const envSlug = envTypeToSlug(environmentType);
  return pullEnvVarsBeforeBuild.includes(envSlug);
}

export function isAtomicBuildsEnabledForEnvironment(
  atomicBuilds: EnvSlug[] | null | undefined,
  environmentType: TriggerEnvironmentType
): boolean {
  if (!atomicBuilds || atomicBuilds.length === 0) {
    return false;
  }
  const envSlug = envTypeToSlug(environmentType);
  return atomicBuilds.includes(envSlug);
}
