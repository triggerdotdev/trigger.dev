import { z } from "zod";

/**
 * Environment slugs used in API keys and configuration.
 * These map to RuntimeEnvironmentType as follows:
 * - "dev" → DEVELOPMENT
 * - "stg" → STAGING
 * - "prod" → PRODUCTION
 * - "preview" → PREVIEW
 */
export const EnvSlugSchema = z.enum(["dev", "stg", "prod", "preview"]);
export type EnvSlug = z.infer<typeof EnvSlugSchema>;

/**
 * Configuration for the Vercel integration.
 *
 * These settings control how the integration behaves when syncing environment variables
 * and responding to Vercel deployment/build events.
 */
export const VercelIntegrationConfigSchema = z.object({
  /**
   * Array of environment slugs to enable atomic deployments for.
   * When an environment slug is in this array, Trigger.dev deployment waits for
   * Vercel deployment to complete before promoting.
   *
   * Example: ["prod"] enables atomic builds for production only
   * null/undefined = atomic builds disabled for all environments
   */
  atomicBuilds: z.array(EnvSlugSchema).nullable().optional(),

  /**
   * Array of environment slugs to pull env vars for before build.
   * When an environment slug is in this array, env vars are pulled from Vercel
   * before each Trigger.dev build starts for that environment.
   *
   * Example: ["prod", "stg"] will pull Vercel env vars for production and staging builds
   * null/undefined = env var pulling disabled for all environments
   */
  pullEnvVarsBeforeBuild: z.array(EnvSlugSchema).nullable().optional(),

  /**
   * Maps a custom Vercel environment to Trigger.dev's staging environment.
   * Vercel environments:
   * - production → Trigger.dev production (automatic)
   * - preview → Trigger.dev preview (automatic)
   * - development → Trigger.dev development (automatic)
   * - custom environments → user can select one to map to Trigger.dev staging
   *
   * This field stores the custom Vercel environment ID that maps to staging.
   * When null, no custom environment is mapped to staging.
   */
  vercelStagingEnvironment: z.object({
    environmentId: z.string(),
    displayName: z.string(),
  }).nullable().optional(),

  /**
   * When enabled, discovers and creates new env vars from Vercel during builds.
   * This allows new environment variables added in Vercel to be automatically
   * pulled into Trigger.dev.
   *
   * Default: true (enabled)
   * null/undefined = defaults to enabled
   * false = only sync existing variables, don't discover new ones
   */
  pullNewEnvVars: z.boolean().nullable().optional(),
});

export type VercelIntegrationConfig = z.infer<typeof VercelIntegrationConfigSchema>;

/**
 * Environment types for sync mapping (RuntimeEnvironmentType from database)
 */
export const TriggerEnvironmentType = z.enum(["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"]);
export type TriggerEnvironmentType = z.infer<typeof TriggerEnvironmentType>;

/**
 * Mapping of environment slugs to per-variable sync settings.
 *
 * Structure: { [envSlug]: { [varName]: boolean } }
 *
 * - If an env slug is missing from this map, all variables are synced by default for that environment.
 * - For each environment, you can enable/disable syncing per variable.
 * - If a variable is missing from an environment's settings, it defaults to sync (true).
 * - Secret environment variables from Vercel cannot be synced due to API limitations.
 *
 * @example
 * {
 *   "prod": {
 *     "DATABASE_URL": true,    // sync for production
 *     "DEBUG_MODE": false      // don't sync for production
 *   },
 *   "stg": {
 *     "DATABASE_URL": true,
 *     "DEBUG_MODE": true
 *   }
 *   // "dev" is not in the map - all variables will be synced for dev by default
 * }
 */
export const SyncEnvVarsMappingSchema = z.record(EnvSlugSchema, z.record(z.string(), z.boolean())).default({});

export type SyncEnvVarsMapping = z.infer<typeof SyncEnvVarsMappingSchema>;

/**
 * The complete integrationData schema for OrganizationProjectIntegration
 * when the integration service is VERCEL.
 *
 * This is stored in the `integrationData` JSON field of OrganizationProjectIntegration.
 */
export const VercelProjectIntegrationDataSchema = z.object({
  /**
   * Configuration settings for the Vercel integration
   */
  config: VercelIntegrationConfigSchema,

  /**
   * Mapping of environment slugs to per-variable sync settings.
   * See SyncEnvVarsMappingSchema for detailed documentation.
   */
  syncEnvVarsMapping: SyncEnvVarsMappingSchema,

  /**
   * The name of the Vercel project (for display purposes)
   */
  vercelProjectName: z.string(),

  /**
   * The Vercel team/organization ID (null for personal accounts)
   */
  vercelTeamId: z.string().nullable(),

  /**
   * The Vercel project ID.
   * Note: This is also stored in OrganizationProjectIntegration.externalEntityId
   * but duplicated here for convenience.
   */
  vercelProjectId: z.string(),
});

export type VercelProjectIntegrationData = z.infer<typeof VercelProjectIntegrationDataSchema>;

/**
 * Helper function to create default integration data for a new Vercel project connection.
 * Defaults to having atomic builds enabled for production and pull env vars enabled for all non-dev environments.
 */
export function createDefaultVercelIntegrationData(
  vercelProjectId: string,
  vercelProjectName: string,
  vercelTeamId: string | null
): VercelProjectIntegrationData {
  return {
    config: {
      atomicBuilds: ["prod"],
      pullEnvVarsBeforeBuild: ["prod", "stg", "preview"],
      pullNewEnvVars: true,
      vercelStagingEnvironment: null,
    },
    syncEnvVarsMapping: {},
    vercelProjectId,
    vercelProjectName,
    vercelTeamId,
  };
}

/**
 * Check if pull new env vars is enabled.
 * Defaults to true if not explicitly set to false.
 */
export function isPullNewEnvVarsEnabled(
  pullNewEnvVars: boolean | null | undefined
): boolean {
  return pullNewEnvVars !== false;
}

/**
 * Convert RuntimeEnvironmentType to EnvSlug
 */
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

/**
 * Convert EnvSlug to RuntimeEnvironmentType
 */
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

/**
 * Type guard to check if env var should be synced for a specific environment.
 * Returns true if:
 *   - The environment slug is not in the mapping (sync all vars by default)
 *   - The env var is not in the environment's settings (sync by default)
 *   - The value is explicitly true
 * Returns false only when explicitly set to false for the environment.
 */
export function shouldSyncEnvVar(
  mapping: SyncEnvVarsMapping,
  envVarName: string,
  environmentType: TriggerEnvironmentType
): boolean {
  const envSlug = envTypeToSlug(environmentType);
  const envSettings = mapping[envSlug];
  // If environment not in mapping, sync all vars by default
  if (!envSettings) {
    return true;
  }
  const value = envSettings[envVarName];
  // If env var not specified for this environment, default to true (sync by default)
  // Only skip if explicitly set to false
  return value !== false;
}

/**
 * Check if env var should be synced for any environment.
 * Used for display purposes to determine if an env var is partially or fully enabled.
 */
export function shouldSyncEnvVarForAnyEnvironment(
  mapping: SyncEnvVarsMapping,
  envVarName: string
): boolean {
  const envSlugs: EnvSlug[] = ["dev", "stg", "prod", "preview"];

  // Check each environment
  for (const slug of envSlugs) {
    const envSettings = mapping[slug];
    // If environment not in mapping, all vars are synced by default
    if (!envSettings) {
      return true;
    }
    // If var is explicitly true or not specified for this environment, it's enabled
    if (envSettings[envVarName] !== false) {
      return true;
    }
  }

  return false;
}

/**
 * Check if pull env vars is enabled for a specific environment.
 */
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

/**
 * Check if atomic builds is enabled for a specific environment.
 */
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
