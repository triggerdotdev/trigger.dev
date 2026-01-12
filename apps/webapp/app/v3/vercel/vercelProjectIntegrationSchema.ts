import { z } from "zod";

/**
 * Configuration for the Vercel integration.
 *
 * These settings control how the integration behaves when syncing environment variables
 * and responding to Vercel deployment/build events.
 */
export const VercelIntegrationConfigSchema = z.object({
  /**
   * When true, environment variables are pulled from Vercel during builds/deployments.
   * This is the main toggle that controls whether env var syncing is enabled.
   */
  pullEnvVarsFromVercel: z.boolean().default(true),

  /**
   * When true, a Trigger.dev deployment is spawned when a Vercel deployment event occurs.
   * This will be handled by the webhook implementation in the other repository.
   */
  spawnDeploymentOnVercelEvent: z.boolean().default(false),

  /**
   * When true, a Trigger.dev build is spawned when a Vercel build event occurs.
   * This will be handled by the webhook implementation in the other repository.
   */
  spawnBuildOnVercelEvent: z.boolean().default(false),

  /**
   * Maps a custom Vercel environment to Trigger.dev's staging environment.
   * Vercel environments:
   * - production → Trigger.dev production (automatic)
   * - preview → Trigger.dev preview (automatic)
   * - development → not mapped
   * - custom environments → user can select one to map to Trigger.dev staging
   *
   * This field stores the custom Vercel environment ID that maps to staging.
   * When null, no custom environment is mapped to staging.
   */
  vercelStagingEnvironment: z.string().nullable().default(null),

  /**
   * The name (slug) of the custom Vercel environment mapped to staging.
   * This is stored for display purposes to avoid needing to look up the name from the ID.
   * When null, no custom environment is mapped to staging.
   */
  vercelStagingName: z.string().nullable().default(null),
});

export type VercelIntegrationConfig = z.infer<typeof VercelIntegrationConfigSchema>;

/**
 * Environment types for sync mapping
 */
export const TriggerEnvironmentType = z.enum(["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"]);
export type TriggerEnvironmentType = z.infer<typeof TriggerEnvironmentType>;

/**
 * Per-environment sync settings for a single environment variable.
 */
export const EnvVarSyncSettingsSchema = z.record(TriggerEnvironmentType, z.boolean());
export type EnvVarSyncSettings = z.infer<typeof EnvVarSyncSettingsSchema>;

/**
 * Mapping of environment variable names to per-environment sync settings.
 *
 * - If an env var name is missing from this map, it is synced by default for ALL environments.
 * - For each env var, you can enable/disable syncing per environment.
 * - If an environment is missing from the env var's settings, it defaults to sync (true).
 * - Secret environment variables from Vercel cannot be synced due to API limitations.
 *
 * @example
 * {
 *   "DATABASE_URL": {
 *     "PRODUCTION": true,    // sync for production
 *     "STAGING": false,      // don't sync for staging
 *     "PREVIEW": true,       // sync for preview
 *     "DEVELOPMENT": false   // don't sync for development
 *   },
 *   // "API_KEY" is not in the map - will be synced for all environments by default
 * }
 */
export const SyncEnvVarsMappingSchema = z.record(z.string(), EnvVarSyncSettingsSchema);

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
   * Mapping of environment variable names to whether they should be synced.
   * See SyncEnvVarsMappingSchema for detailed documentation.
   */
  syncEnvVarsMapping: SyncEnvVarsMappingSchema.default({}),

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
 */
export function createDefaultVercelIntegrationData(
  vercelProjectId: string,
  vercelProjectName: string,
  vercelTeamId: string | null
): VercelProjectIntegrationData {
  return {
    config: {
      pullEnvVarsFromVercel: true,
      spawnDeploymentOnVercelEvent: false,
      spawnBuildOnVercelEvent: false,
      vercelStagingEnvironment: null,
      vercelStagingName: null,
    },
    syncEnvVarsMapping: {},
    vercelProjectId,
    vercelProjectName,
    vercelTeamId,
  };
}

/**
 * Type guard to check if env var should be synced for a specific environment.
 * Returns true if:
 *   - The env var is not in the mapping (sync all by default)
 *   - The environment is not in the env var's settings (sync by default)
 *   - The value is explicitly true
 * Returns false only when explicitly set to false for the environment.
 */
export function shouldSyncEnvVar(
  mapping: SyncEnvVarsMapping,
  envVarName: string,
  environmentType: TriggerEnvironmentType
): boolean {
  const envVarSettings = mapping[envVarName];
  // If env var not in mapping, sync by default for all environments
  if (!envVarSettings) {
    return true;
  }
  const value = envVarSettings[environmentType];
  // If environment not specified, default to true (sync by default)
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
  const envVarSettings = mapping[envVarName];
  // If env var not in mapping, sync by default for all environments
  if (!envVarSettings) {
    return true;
  }
  // Check if at least one environment is enabled
  const environments: TriggerEnvironmentType[] = ["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"];
  return environments.some((env) => envVarSettings[env] !== false);
}
