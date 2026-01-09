import { Vercel } from "@vercel/sdk";
import {
  IntegrationService,
  Organization,
  OrganizationIntegration,
  SecretReference,
} from "@trigger.dev/database";
import { z } from "zod";
import { $transaction, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import {
  createDefaultVercelIntegrationData,
  SyncEnvVarsMapping,
  shouldSyncEnvVar,
  TriggerEnvironmentType,
} from "~/v3/vercel/vercelProjectIntegrationSchema";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";

/**
 * Schema for the Vercel OAuth token stored in SecretReference
 */
export const VercelSecretSchema = z.object({
  accessToken: z.string(),
  tokenType: z.string().optional(),
  teamId: z.string().nullable().optional(),
  userId: z.string().optional(),
  installationId: z.string().optional(),
  raw: z.record(z.any()).optional(),
});

export type VercelSecret = z.infer<typeof VercelSecretSchema>;

/**
 * Represents a Vercel environment variable with metadata
 */
export type VercelEnvironmentVariable = {
  id: string;
  key: string;
  /**
   * Type of the environment variable.
   * "secret" or "sensitive" types cannot have their values retrieved.
   */
  type: "system" | "encrypted" | "plain" | "sensitive" | "secret";
  /**
   * Whether this env var is a secret (value cannot be synced)
   */
  isSecret: boolean;
  /**
   * Target environments for this variable
   */
  target: string[];
  /**
   * Whether this is a shared (team-level) environment variable
   */
  isShared?: boolean;
};

/**
 * Represents a custom Vercel environment
 */
export type VercelCustomEnvironment = {
  id: string;
  slug: string;
  description?: string;
  branchMatcher?: {
    pattern: string;
    type: string;
  };
};

/**
 * Repository for interacting with Vercel API using @vercel/sdk
 */
export class VercelIntegrationRepository {
  /**
   * Get an authenticated Vercel SDK client for an integration
   */
  static async getVercelClient(
    integration: OrganizationIntegration & { tokenReference: SecretReference }
  ): Promise<Vercel> {
    const secretStore = getSecretStore(integration.tokenReference.provider);

    const secret = await secretStore.getSecret(
      VercelSecretSchema,
      integration.tokenReference.key
    );

    if (!secret) {
      throw new Error("Failed to get Vercel access token");
    }

    return new Vercel({
      bearerToken: secret.accessToken,
    });
  }

  /**
   * Get the team ID from an integration's stored secret
   */
  static async getTeamIdFromIntegration(
    integration: OrganizationIntegration & { tokenReference: SecretReference }
  ): Promise<string | null> {
    const secretStore = getSecretStore(integration.tokenReference.provider);

    const secret = await secretStore.getSecret(
      VercelSecretSchema,
      integration.tokenReference.key
    );

    if (!secret) {
      return null;
    }

    return secret.teamId ?? null;
  }

  /**
   * Fetch custom environments for a Vercel project.
   * Excludes standard environments (production, preview, development).
   */
  static async getVercelCustomEnvironments(
    client: Vercel,
    projectId: string,
    teamId?: string | null
  ): Promise<VercelCustomEnvironment[]> {
    try {
      const response = await client.environment.getV9ProjectsIdOrNameCustomEnvironments({
        idOrName: projectId,
        ...(teamId && { teamId }),
      });

      // The response contains environments array
      const environments = response.environments || [];

      return environments.map((env: any) => ({
        id: env.id,
        slug: env.slug,
        description: env.description,
        branchMatcher: env.branchMatcher,
      }));
    } catch (error) {
      logger.error("Failed to fetch Vercel custom environments", {
        projectId,
        teamId,
        error,
      });
      return [];
    }
  }

  /**
   * Fetch all environment variables for a Vercel project.
   * Returns metadata about each variable including whether it's a secret.
   */
  static async getVercelEnvironmentVariables(
    client: Vercel,
    projectId: string,
    teamId?: string | null
  ): Promise<VercelEnvironmentVariable[]> {
    try {
      const response = await client.projects.filterProjectEnvs({
        idOrName: projectId,
        ...(teamId && { teamId }),
      });

      // The response is a union type - check if it has envs array
      const envs = "envs" in response && Array.isArray(response.envs) ? response.envs : [];

      return envs.map((env: any) => {
        const type = env.type as VercelEnvironmentVariable["type"];
        // Secret and sensitive types cannot have their values retrieved
        const isSecret = type === "secret" || type === "sensitive";

        return {
          id: env.id,
          key: env.key,
          type,
          isSecret,
          target: Array.isArray(env.target) ? env.target : [env.target].filter(Boolean),
        };
      });
    } catch (error) {
      logger.error("Failed to fetch Vercel environment variables", {
        projectId,
        teamId,
        error,
      });
      return [];
    }
  }

  /**
   * Represents an environment variable with its decrypted value
   */
  static async getVercelEnvironmentVariableValues(
    client: Vercel,
    projectId: string,
    teamId?: string | null,
    target?: string // Optional: filter by Vercel environment (production, preview, etc.)
  ): Promise<
    Array<{
      key: string;
      value: string;
      target: string[];
      type: string;
      isSecret: boolean;
    }>
  > {
    try {
      const response = await client.projects.filterProjectEnvs({
        idOrName: projectId,
        ...(teamId && { teamId }),
        decrypt: "true",
      });

      // The response is a union type - check if it has envs array
      const envs =
        "envs" in response && Array.isArray(response.envs) ? response.envs : [];

      // Filter and map env vars
      const result = envs
        .filter((env: any) => {
          // Skip env vars without values (secrets/sensitive types won't have values even with decrypt=true)
          if (!env.value) {
            return false;
          }
          // Filter by target if provided
          if (target) {
            const envTargets = Array.isArray(env.target)
              ? env.target
              : [env.target].filter(Boolean);
            return envTargets.includes(target);
          }
          return true;
        })
        .map((env: any) => {
          const type = env.type as string;
          const isSecret = type === "secret" || type === "sensitive";

          return {
            key: env.key as string,
            value: env.value as string,
            target: Array.isArray(env.target)
              ? env.target
              : [env.target].filter(Boolean),
            type,
            isSecret,
          };
        });

      return result;
    } catch (error) {
      logger.error("Failed to fetch Vercel environment variable values", {
        projectId,
        teamId,
        target,
        error,
      });
      return [];
    }
  }

  /**
   * Fetch shared environment variables metadata from Vercel team.
   * Returns metadata about each variable (not values).
   * Shared env vars are team-level variables that can be linked to multiple projects.
   */
  static async getVercelSharedEnvironmentVariables(
    client: Vercel,
    teamId: string,
    projectId?: string // Optional: filter by project
  ): Promise<
    Array<{
      id: string;
      key: string;
      type: string;
      isSecret: boolean;
      target: string[];
    }>
  > {
    try {
      const response = await client.environment.listSharedEnvVariable({
        teamId,
        ...(projectId && { projectId }),
      });

      const envVars = response.data || [];

      return envVars.map((env) => {
        const type = (env.type as string) || "plain";
        const isSecret = type === "secret" || type === "sensitive";

        return {
          id: env.id as string,
          key: env.key as string,
          type,
          isSecret,
          target: Array.isArray(env.target)
            ? (env.target as string[])
            : [env.target].filter(Boolean) as string[],
        };
      });
    } catch (error) {
      logger.error("Failed to fetch Vercel shared environment variables", {
        teamId,
        projectId,
        error,
      });
      return [];
    }
  }

  /**
   * Fetch shared environment variables from Vercel team with their values.
   * Returns decrypted values where available.
   * Shared env vars are team-level variables that can be linked to multiple projects.
   */
  static async getVercelSharedEnvironmentVariableValues(
    client: Vercel,
    teamId: string,
    projectId?: string // Optional: filter by project
  ): Promise<
    Array<{
      key: string;
      value: string;
      target: string[];
      type: string;
      isSecret: boolean;
      applyToAllCustomEnvironments?: boolean;
    }>
  > {
    try {
      // First, get the list of shared env vars
      logger.debug("Fetching shared env vars list from Vercel", {
        teamId,
        projectId,
      });

      const listResponse = await client.environment.listSharedEnvVariable({
        teamId,
        ...(projectId && { projectId }),
      });

      const envVars = listResponse.data || [];

      logger.info("Listed shared env vars from Vercel", {
        teamId,
        projectId,
        count: envVars.length,
        envVarsInfo: envVars.map((e) => ({
          key: e.key,
          type: e.type,
          hasValueInList: !!e.value,
          decrypted: (e as any).decrypted,
          target: e.target,
        })),
      });

      if (envVars.length === 0) {
        return [];
      }

      // Process each shared env var
      // The list response may already include values for plain types
      // For encrypted types, we need to call getSharedEnvVar for decrypted values
      const results = await Promise.all(
        envVars.map(async (env) => {
          const type = (env.type as string) || "plain";
          // Note: Vercel shared env var types are: plain, encrypted, sensitive, system
          // sensitive types should not have values returned (like secrets)
          const isSecret = type === "sensitive";

          // Skip sensitive types early - they won't have values
          if (isSecret) {
            logger.debug("Skipping sensitive shared env var", {
              teamId,
              envKey: env.key,
              type,
            });
            return null;
          }

          // Check if value is already available in list response
          const listValue = (env as any).value as string | undefined;
          const applyToAllCustomEnvs = (env as any).applyToAllCustomEnvironments as boolean | undefined;

          if (listValue) {
            logger.debug("Using value from list response for shared env var", {
              teamId,
              envKey: env.key,
              type,
              valueLength: listValue.length,
              applyToAllCustomEnvironments: applyToAllCustomEnvs,
            });

            return {
              key: env.key as string,
              value: listValue,
              target: Array.isArray(env.target)
                ? (env.target as string[])
                : [env.target].filter(Boolean) as string[],
              type,
              isSecret,
              applyToAllCustomEnvironments: applyToAllCustomEnvs,
            };
          }

          // Value not in list response, try fetching with getSharedEnvVar
          try {
            logger.debug("Fetching decrypted value for shared env var", {
              teamId,
              envId: env.id,
              envKey: env.key,
              envType: env.type,
              envTarget: env.target,
            });

            // Get the decrypted value for this shared env var
            const getResponse = await client.environment.getSharedEnvVar({
              id: env.id as string,
              teamId,
            });

            logger.debug("Got response for shared env var from getSharedEnvVar", {
              teamId,
              envId: env.id,
              envKey: env.key,
              hasValue: !!getResponse.value,
              valueLength: getResponse.value?.length,
              isDecrypted: (getResponse as any).decrypted,
              responseKeys: Object.keys(getResponse),
            });

            // Skip if no value
            if (!getResponse.value) {
              logger.debug("Skipping shared env var - no value returned from getSharedEnvVar", {
                teamId,
                envId: env.id,
                envKey: env.key,
                type,
              });
              return null;
            }

            const result = {
              key: env.key as string,
              value: getResponse.value as string,
              target: Array.isArray(env.target)
                ? (env.target as string[])
                : [env.target].filter(Boolean) as string[],
              type,
              isSecret,
              applyToAllCustomEnvironments: (env as any).applyToAllCustomEnvironments as boolean | undefined,
            };

            logger.debug("Successfully fetched shared env var value from getSharedEnvVar", {
              teamId,
              envKey: result.key,
              target: result.target,
              valueLength: result.value.length,
            });

            return result;
          } catch (error) {
            // Try to extract value from error.rawValue if it's a ResponseValidationError
            // The API response is valid but SDK schema validation fails (e.g., deletedAt: null vs expected number)
            let errorValue: string | undefined;
            if (error && typeof error === "object" && "rawValue" in error) {
              const rawValue = (error as any).rawValue;
              if (rawValue && typeof rawValue === "object" && "value" in rawValue) {
                errorValue = rawValue.value as string | undefined;
              }
            }

            // Use error.rawValue if available, otherwise fall back to listValue
            const fallbackValue = errorValue || listValue;

            if (fallbackValue) {
              logger.warn("getSharedEnvVar failed validation, using value from error.rawValue or list response", {
                teamId,
                envId: env.id,
                envKey: env.key,
                error: error instanceof Error ? error.message : String(error),
                hasErrorRawValue: !!errorValue,
                hasListValue: !!listValue,
                valueLength: fallbackValue.length,
              });
              return {
                key: env.key as string,
                value: fallbackValue,
                target: Array.isArray(env.target)
                  ? (env.target as string[])
                  : [env.target].filter(Boolean) as string[],
                type,
                isSecret,
                applyToAllCustomEnvironments: applyToAllCustomEnvs,
              };
            }

            // No fallback value available, skip this env var
            logger.warn("Failed to get decrypted value for shared env var, no fallback available", {
              teamId,
              projectId,
              envId: env.id,
              envKey: env.key,
              error: error instanceof Error ? error.message : String(error),
              errorStack: error instanceof Error ? error.stack : undefined,
              hasRawValue: error && typeof error === "object" && "rawValue" in error,
            });
            return null;
          }
        })
      );

      // Filter out null results (failed fetches or sensitive types)
      const validResults = results.filter((r): r is NonNullable<typeof r> => r !== null);

      logger.info("Completed fetching shared env var values", {
        teamId,
        projectId,
        totalListed: envVars.length,
        successfullyFetched: validResults.length,
        failedOrSkipped: envVars.length - validResults.length,
        fetchedKeys: validResults.map((r) => r.key),
      });

      return validResults;
    } catch (error) {
      logger.error("Failed to fetch Vercel shared environment variable values", {
        teamId,
        projectId,
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      });
      return [];
    }
  }

  /**
   * Fetch Vercel projects for a team or user
   */
  static async getVercelProjects(
    client: Vercel,
    teamId?: string | null
  ): Promise<Array<{ id: string; name: string }>> {
    try {
      const response = await client.projects.getProjects({
        ...(teamId && { teamId }),
      });

      const projects = response.projects || [];

      return projects.map((project: any) => ({
        id: project.id,
        name: project.name,
      }));
    } catch (error) {
      logger.error("Failed to fetch Vercel projects", {
        teamId,
        error,
      });
      return [];
    }
  }

  /**
   * Create a Vercel organization integration from OAuth callback data.
   * This stores the access token and creates the OrganizationIntegration record.
   */
  static async createVercelOrgIntegration(params: {
    accessToken: string;
    tokenType?: string;
    teamId: string | null;
    userId?: string;
    installationId?: string;
    organization: Organization;
    raw?: Record<string, any>;
  }): Promise<OrganizationIntegration> {
    const result = await $transaction(prisma, async (tx) => {
      const secretStore = getSecretStore("DATABASE", {
        prismaClient: tx,
      });

      const integrationFriendlyId = generateFriendlyId("org_integration");

      const secretValue: VercelSecret = {
        accessToken: params.accessToken,
        tokenType: params.tokenType,
        teamId: params.teamId,
        userId: params.userId,
        installationId: params.installationId,
        raw: params.raw,
      };

      logger.debug("Storing Vercel secret", {
        teamId: params.teamId,
        installationId: params.installationId,
      });

      await secretStore.setSecret(integrationFriendlyId, secretValue);

      const reference = await tx.secretReference.create({
        data: {
          provider: "DATABASE",
          key: integrationFriendlyId,
        },
      });

      return await tx.organizationIntegration.create({
        data: {
          friendlyId: integrationFriendlyId,
          organizationId: params.organization.id,
          service: "VERCEL",
          externalOrganizationId: params.teamId,
          tokenReferenceId: reference.id,
          integrationData: {
            teamId: params.teamId,
            userId: params.userId,
            installationId: params.installationId,
          } as any,
        },
      });
    });

    if (!result) {
      throw new Error("Failed to create Vercel organization integration");
    }

    return result;
  }

  /**
   * Create a Vercel project integration linking a Vercel project to a Trigger.dev project
   */
  static async createVercelProjectIntegration(params: {
    organizationIntegrationId: string;
    projectId: string;
    vercelProjectId: string;
    vercelProjectName: string;
    vercelTeamId: string | null;
    installedByUserId?: string;
  }) {
    const integrationData = createDefaultVercelIntegrationData(
      params.vercelProjectId,
      params.vercelProjectName,
      params.vercelTeamId
    );

    return prisma.organizationProjectIntegration.create({
      data: {
        organizationIntegrationId: params.organizationIntegrationId,
        projectId: params.projectId,
        externalEntityId: params.vercelProjectId,
        integrationData: integrationData as any,
        installedBy: params.installedByUserId,
      },
    });
  }

  /**
   * Find an existing Vercel organization integration by team ID
   */
  static async findVercelOrgIntegrationByTeamId(
    organizationId: string,
    teamId: string | null
  ): Promise<(OrganizationIntegration & { tokenReference: SecretReference }) | null> {
    return prisma.organizationIntegration.findFirst({
      where: {
        organizationId,
        service: "VERCEL",
        externalOrganizationId: teamId,
        deletedAt: null,
      },
      include: {
        tokenReference: true,
      },
    });
  }

  /**
   * Find Vercel organization integration for a project
   */
  static async findVercelOrgIntegrationForProject(
    projectId: string
  ): Promise<(OrganizationIntegration & { tokenReference: SecretReference }) | null> {
    const projectIntegration = await prisma.organizationProjectIntegration.findFirst({
      where: {
        projectId,
        deletedAt: null,
        organizationIntegration: {
          service: "VERCEL",
          deletedAt: null,
        },
      },
      include: {
        organizationIntegration: {
          include: {
            tokenReference: true,
          },
        },
      },
    });

    return projectIntegration?.organizationIntegration ?? null;
  }

  /**
   * Find Vercel organization integration by organization ID
   */
  static async findVercelOrgIntegrationByOrganization(
    organizationId: string
  ): Promise<(OrganizationIntegration & { tokenReference: SecretReference }) | null> {
    return prisma.organizationIntegration.findFirst({
      where: {
        organizationId,
        service: "VERCEL",
        deletedAt: null,
      },
      include: {
        tokenReference: true,
      },
    });
  }

  /**
   * Sync Trigger.dev API keys to Vercel as sensitive environment variables.
   * Uses batch operations to minimize API calls.
   * 
   * Mapping:
   * - Production API key → Vercel "production" environment
   * - Staging API key → Vercel custom environment (from vercelStagingEnvironment config)
   * - Preview API key → Vercel "preview" environment
   * - Development API key → Vercel "development" environment
   * 
   * @param projectId - The Trigger.dev project ID
   * @param vercelProjectId - The Vercel project ID
   * @param teamId - The Vercel team ID (optional)
   * @param vercelStagingEnvironment - The custom Vercel environment slug for staging (optional)
   */
  static async syncApiKeysToVercel(params: {
    projectId: string;
    vercelProjectId: string;
    teamId: string | null;
    vercelStagingEnvironment?: string | null;
    orgIntegration: OrganizationIntegration & { tokenReference: SecretReference };
  }): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      const client = await this.getVercelClient(params.orgIntegration);

      // Get all environments for the project
      const environments = await prisma.runtimeEnvironment.findMany({
        where: {
          projectId: params.projectId,
          type: {
            in: ["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"],
          },
        },
        select: {
          id: true,
          type: true,
          apiKey: true,
        },
      });

      // Build the list of env vars to sync
      const envVarsToSync: Array<{
        key: string;
        value: string;
        target: string[];
        type: "sensitive" | "encrypted" | "plain";
        environmentType: string;
      }> = [];

      for (const env of environments) {
        let vercelTarget: string[];

        switch (env.type) {
          case "PRODUCTION":
            vercelTarget = ["production"];
            break;
          case "STAGING":
            // If no custom staging environment is mapped, skip staging sync
            if (!params.vercelStagingEnvironment) {
              logger.debug("Skipping staging API key sync - no custom environment mapped", {
                projectId: params.projectId,
                vercelProjectId: params.vercelProjectId,
              });
              continue;
            }
            vercelTarget = [params.vercelStagingEnvironment];
            break;
          case "PREVIEW":
            vercelTarget = ["preview"];
            break;
          case "DEVELOPMENT":
            vercelTarget = ["development"];
            break;
          default:
            continue;
        }

        envVarsToSync.push({
          key: "TRIGGER_SECRET_KEY",
          value: env.apiKey,
          target: vercelTarget,
          type: "sensitive",
          environmentType: env.type,
        });
      }

      if (envVarsToSync.length === 0) {
        logger.debug("No API keys to sync to Vercel", {
          projectId: params.projectId,
          vercelProjectId: params.vercelProjectId,
        });
        return { success: true, errors: [] };
      }

      // Use batch upsert to sync all env vars
      const result = await this.batchUpsertVercelEnvVars({
        client,
        vercelProjectId: params.vercelProjectId,
        teamId: params.teamId,
        envVars: envVarsToSync,
      });

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }

      logger.info("Synced API keys to Vercel", {
        projectId: params.projectId,
        vercelProjectId: params.vercelProjectId,
        syncedCount: result.created + result.updated,
        created: result.created,
        updated: result.updated,
        errors: result.errors,
      });

      return {
        success: errors.length === 0,
        errors,
      };
    } catch (error) {
      const errorMessage = `Failed to sync API keys to Vercel: ${error instanceof Error ? error.message : "Unknown error"}`;
      errors.push(errorMessage);
      logger.error(errorMessage, {
        projectId: params.projectId,
        vercelProjectId: params.vercelProjectId,
        error,
      });
      return {
        success: false,
        errors,
      };
    }
  }

  /**
   * Sync a single API key to Vercel for a specific environment.
   * Used when API keys are regenerated.
   */
  static async syncSingleApiKeyToVercel(params: {
    projectId: string;
    environmentType: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT";
    apiKey: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      // Get the project integration
      const projectIntegration = await prisma.organizationProjectIntegration.findFirst({
        where: {
          projectId: params.projectId,
          deletedAt: null,
          organizationIntegration: {
            service: "VERCEL",
            deletedAt: null,
          },
        },
        include: {
          organizationIntegration: {
            include: {
              tokenReference: true,
            },
          },
        },
      });

      if (!projectIntegration) {
        // No Vercel integration - nothing to sync
        return { success: true };
      }

      const orgIntegration = projectIntegration.organizationIntegration;
      const client = await this.getVercelClient(orgIntegration);
      const teamId = await this.getTeamIdFromIntegration(orgIntegration);

      // Parse the integration data to get the staging environment mapping
      const integrationData = projectIntegration.integrationData as any;
      const vercelStagingEnvironment = integrationData?.config?.vercelStagingEnvironment;

      let vercelTarget: string[];

      switch (params.environmentType) {
        case "PRODUCTION":
          vercelTarget = ["production"];
          break;
        case "STAGING":
          if (!vercelStagingEnvironment) {
            logger.debug("Skipping staging API key sync - no custom environment mapped", {
              projectId: params.projectId,
            });
            return { success: true };
          }
          vercelTarget = [vercelStagingEnvironment];
          break;
        case "PREVIEW":
          vercelTarget = ["preview"];
          break;
        case "DEVELOPMENT":
          vercelTarget = ["development"];
          break;
        default:
          return { success: true };
      }

      await this.upsertVercelEnvVar({
        client,
        vercelProjectId: projectIntegration.externalEntityId,
        teamId,
        key: "TRIGGER_SECRET_KEY",
        value: params.apiKey,
        target: vercelTarget,
        type: "plain",
      });

      logger.info("Synced regenerated API key to Vercel", {
        projectId: params.projectId,
        vercelProjectId: projectIntegration.externalEntityId,
        environmentType: params.environmentType,
        target: vercelTarget,
      });

      return { success: true };
    } catch (error) {
      const errorMessage = `Failed to sync API key to Vercel: ${error instanceof Error ? error.message : "Unknown error"}`;
      logger.error(errorMessage, {
        projectId: params.projectId,
        environmentType: params.environmentType,
        error,
      });
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Pull environment variables from Vercel and store them in the Trigger.dev database.
   * 
   * Environment mapping:
   * - Vercel "production" → Trigger.dev PRODUCTION
   * - Vercel "preview" → Trigger.dev PREVIEW
   * - Vercel custom environment (vercelStagingEnvironment) → Trigger.dev STAGING
   * 
   * @param projectId - The Trigger.dev project ID
   * @param vercelProjectId - The Vercel project ID
   * @param teamId - The Vercel team ID (optional)
   * @param vercelStagingEnvironment - The custom Vercel environment slug for staging (optional)
   * @param syncEnvVarsMapping - Mapping of which env vars to sync (vars with false are skipped)
   * @param orgIntegration - Organization integration with token reference
   */
  static async pullEnvVarsFromVercel(params: {
    projectId: string;
    vercelProjectId: string;
    teamId: string | null;
    vercelStagingEnvironment?: string | null;
    syncEnvVarsMapping: SyncEnvVarsMapping;
    orgIntegration: OrganizationIntegration & { tokenReference: SecretReference };
  }): Promise<{ success: boolean; errors: string[]; syncedCount: number }> {
    const errors: string[] = [];
    let syncedCount = 0;

    try {
      const client = await this.getVercelClient(params.orgIntegration);

      // Get all runtime environments for the project
      const runtimeEnvironments = await prisma.runtimeEnvironment.findMany({
        where: {
          projectId: params.projectId,
          type: {
            in: ["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"],
          },
        },
        select: {
          id: true,
          type: true,
        },
      });

      // Build environment mapping: Trigger.dev env type → Vercel target
      const envMapping: Array<{
        triggerEnvType: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT";
        vercelTarget: string;
        runtimeEnvironmentId: string;
      }> = [];

      for (const env of runtimeEnvironments) {
        switch (env.type) {
          case "PRODUCTION":
            envMapping.push({
              triggerEnvType: "PRODUCTION",
              vercelTarget: "production",
              runtimeEnvironmentId: env.id,
            });
            break;
          case "PREVIEW":
            envMapping.push({
              triggerEnvType: "PREVIEW",
              vercelTarget: "preview",
              runtimeEnvironmentId: env.id,
            });
            break;
          case "STAGING":
            // Only map staging if a custom environment is configured
            if (params.vercelStagingEnvironment) {
              envMapping.push({
                triggerEnvType: "STAGING",
                vercelTarget: params.vercelStagingEnvironment,
                runtimeEnvironmentId: env.id,
              });
            }
            break;
          case "DEVELOPMENT":
            envMapping.push({
              triggerEnvType: "DEVELOPMENT",
              vercelTarget: "development",
              runtimeEnvironmentId: env.id,
            });
            break;
        }
      }

      if (envMapping.length === 0) {
        logger.warn("No environments to sync for Vercel integration", {
          projectId: params.projectId,
          vercelProjectId: params.vercelProjectId,
        });
        return { success: true, errors: [], syncedCount: 0 };
      }

      const envVarRepository = new EnvironmentVariablesRepository();

      // Fetch shared env vars once (they apply across all targets)
      let sharedEnvVars: Array<{
        key: string;
        value: string;
        target: string[];
        type: string;
        isSecret: boolean;
        applyToAllCustomEnvironments?: boolean;
      }> = [];

      if (params.teamId) {
        logger.info("Fetching shared env vars for pull operation", {
          projectId: params.projectId,
          vercelProjectId: params.vercelProjectId,
          teamId: params.teamId,
        });

        sharedEnvVars = await this.getVercelSharedEnvironmentVariableValues(
          client,
          params.teamId,
          params.vercelProjectId
        );

        logger.info("Fetched shared env vars from Vercel for pull", {
          projectId: params.projectId,
          vercelProjectId: params.vercelProjectId,
          count: sharedEnvVars.length,
          keys: sharedEnvVars.map((v) => v.key),
          targets: sharedEnvVars.map((v) => ({ key: v.key, target: v.target })),
        });
      } else {
        logger.debug("Skipping shared env vars fetch - no teamId", {
          projectId: params.projectId,
          vercelProjectId: params.vercelProjectId,
        });
      }

      // Process each environment mapping
      for (const mapping of envMapping) {
        try {
          // Fetch project-level env vars from Vercel for this target
          const projectEnvVars = await this.getVercelEnvironmentVariableValues(
            client,
            params.vercelProjectId,
            params.teamId,
            mapping.vercelTarget
          );

          logger.debug("Fetched project env vars for target", {
            projectId: params.projectId,
            vercelTarget: mapping.vercelTarget,
            triggerEnvType: mapping.triggerEnvType,
            projectEnvVarsCount: projectEnvVars.length,
            projectEnvVarKeys: projectEnvVars.map((v) => v.key),
          });

          // Filter shared env vars that target this environment
          const standardTargets = ["production", "preview", "development"];
          const isCustomEnvironment = !standardTargets.includes(mapping.vercelTarget);

          const filteredSharedEnvVars = sharedEnvVars.filter((envVar) => {
            // Check if this shared env var targets the current Vercel environment
            const matchesTarget = envVar.target.includes(mapping.vercelTarget);

            // Also include if applyToAllCustomEnvironments is true and this is a custom environment
            const matchesCustomEnv = isCustomEnvironment && envVar.applyToAllCustomEnvironments === true;

            const matches = matchesTarget || matchesCustomEnv;

            if (!matches) {
              logger.debug("Shared env var excluded - target mismatch", {
                envKey: envVar.key,
                envVarTarget: envVar.target,
                expectedTarget: mapping.vercelTarget,
                isCustomEnvironment,
                applyToAllCustomEnvironments: envVar.applyToAllCustomEnvironments,
              });
            }
            return matches;
          });

          logger.info("Filtered shared env vars for target", {
            projectId: params.projectId,
            vercelTarget: mapping.vercelTarget,
            triggerEnvType: mapping.triggerEnvType,
            totalSharedEnvVars: sharedEnvVars.length,
            matchingSharedEnvVars: filteredSharedEnvVars.length,
            matchingKeys: filteredSharedEnvVars.map((v) => v.key),
          });

          // Merge project and shared env vars (project vars take precedence)
          const projectEnvVarKeys = new Set(projectEnvVars.map((v) => v.key));
          const sharedEnvVarsToAdd = filteredSharedEnvVars.filter((v) => !projectEnvVarKeys.has(v.key));
          const mergedEnvVars = [
            ...projectEnvVars,
            ...sharedEnvVarsToAdd,
          ];

          logger.info("Merged project and shared env vars", {
            projectId: params.projectId,
            vercelTarget: mapping.vercelTarget,
            projectEnvVarsCount: projectEnvVars.length,
            sharedEnvVarsAddedCount: sharedEnvVarsToAdd.length,
            sharedEnvVarsSkippedDueToOverlap: filteredSharedEnvVars.length - sharedEnvVarsToAdd.length,
            totalMergedCount: mergedEnvVars.length,
            mergedKeys: mergedEnvVars.map((v) => v.key),
          });

          if (mergedEnvVars.length === 0) {
            logger.debug("No env vars found for Vercel target", {
              projectId: params.projectId,
              vercelProjectId: params.vercelProjectId,
              vercelTarget: mapping.vercelTarget,
            });
            continue;
          }

          // Filter env vars based on syncEnvVarsMapping and exclude TRIGGER_SECRET_KEY
          const varsToSync = mergedEnvVars.filter((envVar) => {
            // Skip secrets (they don't have values anyway)
            if (envVar.isSecret) {
              logger.debug("Env var excluded - is secret", { envKey: envVar.key });
              return false;
            }
            // Filter out TRIGGER_SECRET_KEY - these are managed by Trigger.dev
            if (envVar.key === "TRIGGER_SECRET_KEY") {
              logger.debug("Env var excluded - is TRIGGER_SECRET_KEY", { envKey: envVar.key });
              return false;
            }
            // Check if this var should be synced based on mapping for this environment
            const shouldSync = shouldSyncEnvVar(
              params.syncEnvVarsMapping,
              envVar.key,
              mapping.triggerEnvType as TriggerEnvironmentType
            );
            if (!shouldSync) {
              logger.debug("Env var excluded - disabled in sync mapping", {
                envKey: envVar.key,
                environmentType: mapping.triggerEnvType,
              });
            }
            return shouldSync;
          });

          logger.info("Filtered env vars to sync", {
            projectId: params.projectId,
            vercelTarget: mapping.vercelTarget,
            triggerEnvType: mapping.triggerEnvType,
            totalMergedCount: mergedEnvVars.length,
            varsToSyncCount: varsToSync.length,
            varsToSyncKeys: varsToSync.map((v) => v.key),
          });

          if (varsToSync.length === 0) {
            logger.debug("No env vars to sync after filtering", {
              projectId: params.projectId,
              vercelProjectId: params.vercelProjectId,
              vercelTarget: mapping.vercelTarget,
              totalVars: mergedEnvVars.length,
            });
            continue;
          }

          // Create env vars in Trigger.dev
          logger.info("Saving env vars to Trigger.dev", {
            projectId: params.projectId,
            runtimeEnvironmentId: mapping.runtimeEnvironmentId,
            vercelTarget: mapping.vercelTarget,
            triggerEnvType: mapping.triggerEnvType,
            variableCount: varsToSync.length,
            variableKeys: varsToSync.map((v) => v.key),
          });

          const result = await envVarRepository.create(params.projectId, {
            override: true, // Override existing vars
            environmentIds: [mapping.runtimeEnvironmentId],
            isSecret: false, // Vercel env vars we can read are not secrets in our system
            variables: varsToSync.map((v) => ({
              key: v.key,
              value: v.value,
            })),
          });

          if (result.success) {
            syncedCount += varsToSync.length;
            logger.info("Successfully synced env vars from Vercel to Trigger.dev", {
              projectId: params.projectId,
              vercelProjectId: params.vercelProjectId,
              vercelTarget: mapping.vercelTarget,
              triggerEnvType: mapping.triggerEnvType,
              count: varsToSync.length,
              keys: varsToSync.map((v) => v.key),
            });
          } else {
            const errorMsg = `Failed to sync env vars for ${mapping.triggerEnvType}: ${result.error}`;
            errors.push(errorMsg);
            logger.error(errorMsg, {
              projectId: params.projectId,
              vercelProjectId: params.vercelProjectId,
              vercelTarget: mapping.vercelTarget,
              error: result.error,
              variableErrors: result.variableErrors,
              attemptedKeys: varsToSync.map((v) => v.key),
            });
          }
        } catch (envError) {
          const errorMsg = `Failed to process env vars for ${mapping.triggerEnvType}: ${envError instanceof Error ? envError.message : "Unknown error"}`;
          errors.push(errorMsg);
          logger.error(errorMsg, {
            projectId: params.projectId,
            vercelProjectId: params.vercelProjectId,
            vercelTarget: mapping.vercelTarget,
            error: envError,
          });
        }
      }

      return {
        success: errors.length === 0,
        errors,
        syncedCount,
      };
    } catch (error) {
      const errorMsg = `Failed to pull env vars from Vercel: ${error instanceof Error ? error.message : "Unknown error"}`;
      errors.push(errorMsg);
      logger.error(errorMsg, {
        projectId: params.projectId,
        vercelProjectId: params.vercelProjectId,
        error,
      });
      return {
        success: false,
        errors,
        syncedCount,
      };
    }
  }

  /**
   * Batch create or update environment variables in Vercel.
   * Fetches existing env vars once, then creates new ones in a single batch request
   * and updates existing ones individually (Vercel doesn't support batch updates).
   */
  static async batchUpsertVercelEnvVars(params: {
    client: Vercel;
    vercelProjectId: string;
    teamId: string | null;
    envVars: Array<{
      key: string;
      value: string;
      target: string[];
      type: "sensitive" | "encrypted" | "plain";
      environmentType?: string; // For logging purposes
    }>;
  }): Promise<{ created: number; updated: number; errors: string[] }> {
    const { client, vercelProjectId, teamId, envVars } = params;
    const errors: string[] = [];
    let created = 0;
    let updated = 0;

    if (envVars.length === 0) {
      return { created: 0, updated: 0, errors: [] };
    }

    // Fetch all existing env vars once
    const existingEnvs = await client.projects.filterProjectEnvs({
      idOrName: vercelProjectId,
      ...(teamId && { teamId }),
    });

    const existingEnvsList =
      "envs" in existingEnvs && Array.isArray(existingEnvs.envs) ? existingEnvs.envs : [];

    // Separate env vars into ones that need to be created vs updated
    const toCreate: Array<{
      key: string;
      value: string;
      target: string[];
      type: "sensitive" | "encrypted" | "plain";
    }> = [];

    const toUpdate: Array<{
      id: string;
      key: string;
      value: string;
      target: string[];
      type: "sensitive" | "encrypted" | "plain";
      environmentType?: string;
    }> = [];

    for (const envVar of envVars) {
      // Find existing env var with matching key AND target
      const existingEnv = existingEnvsList.find((env: any) => {
        if (env.key !== envVar.key) {
          return false;
        }
        const envTargets = Array.isArray(env.target) ? env.target : [env.target].filter(Boolean);
        return (
          envVar.target.length === envTargets.length &&
          envVar.target.every((t) => envTargets.includes(t))
        );
      });

      if (existingEnv && existingEnv.id) {
        toUpdate.push({
          id: existingEnv.id,
          key: envVar.key,
          value: envVar.value,
          target: envVar.target,
          type: envVar.type,
          environmentType: envVar.environmentType,
        });
      } else {
        toCreate.push({
          key: envVar.key,
          value: envVar.value,
          target: envVar.target,
          type: envVar.type,
        });
      }
    }

    // Batch create new env vars (Vercel supports array in request body)
    if (toCreate.length > 0) {
      try {
        await client.projects.createProjectEnv({
          idOrName: vercelProjectId,
          ...(teamId && { teamId }),
          requestBody: toCreate.map((env) => ({
            key: env.key,
            value: env.value,
            target: env.target as any,
            type: env.type,
          })) as any,
        });
        created = toCreate.length;
      } catch (error) {
        const errorMsg = `Failed to batch create env vars: ${error instanceof Error ? error.message : "Unknown error"}`;
        errors.push(errorMsg);
        logger.error(errorMsg, {
          vercelProjectId,
          teamId,
          count: toCreate.length,
          error,
        });
      }
    }

    // Update existing env vars (Vercel doesn't support batch updates)
    for (const envVar of toUpdate) {
      try {
        await client.projects.editProjectEnv({
          idOrName: vercelProjectId,
          id: envVar.id,
          ...(teamId && { teamId }),
          requestBody: {
            value: envVar.value,
            target: envVar.target as any,
            type: envVar.type,
          },
        });
        updated++;
      } catch (error) {
        const errorMsg = `Failed to update ${envVar.environmentType || envVar.key} env var: ${error instanceof Error ? error.message : "Unknown error"}`;
        errors.push(errorMsg);
        logger.error(errorMsg, {
          vercelProjectId,
          teamId,
          envVarId: envVar.id,
          key: envVar.key,
          error,
        });
      }
    }

    return { created, updated, errors };
  }

  /**
   * Create or update an environment variable in Vercel.
   * First tries to find an existing variable with the same key and target,
   * then either creates or updates it.
   */
  private static async upsertVercelEnvVar(params: {
    client: Vercel;
    vercelProjectId: string;
    teamId: string | null;
    key: string;
    value: string;
    target: string[];
    type: "sensitive" | "encrypted" | "plain";
  }): Promise<void> {
    const { client, vercelProjectId, teamId, key, value, target, type } = params;

    // First, check if the env var already exists for this target
    const existingEnvs = await client.projects.filterProjectEnvs({
      idOrName: vercelProjectId,
      ...(teamId && { teamId }),
    });

    const envs = "envs" in existingEnvs && Array.isArray(existingEnvs.envs) 
      ? existingEnvs.envs 
      : [];

    // Find existing env var with matching key AND target
    // Vercel can have multiple env vars with the same key but different targets
    const existingEnv = envs.find((env: any) => {
      if (env.key !== key) {
        return false;
      }
      // Check if the targets match (env var targets this specific environment)
      const envTargets = Array.isArray(env.target) ? env.target : [env.target].filter(Boolean);
      // Match if the targets are exactly the same
      return target.length === envTargets.length && target.every((t) => envTargets.includes(t));
    });

    if (existingEnv && existingEnv.id) {
      // Update existing env var
      await client.projects.editProjectEnv({
        idOrName: vercelProjectId,
        id: existingEnv.id,
        ...(teamId && { teamId }),
        requestBody: {
          value,
          target: target as any,
          type,
        },
      });
    } else {
      // Create new env var
      await client.projects.createProjectEnv({
        idOrName: vercelProjectId,
        ...(teamId && { teamId }),
        requestBody: {
          key,
          value,
          target: target as any,
          type,
        },
      });
    }
  }

  /**
   * Uninstall a Vercel integration by removing the configuration
   */
  static async uninstallVercelIntegration(
    integration: OrganizationIntegration & { tokenReference: SecretReference }
  ): Promise<void> {
    const client = await this.getVercelClient(integration);

    const secret = await getSecretStore(integration.tokenReference.provider).getSecret(
      VercelSecretSchema,
      integration.tokenReference.key
    );

    if (!secret?.installationId) {
      throw new Error("Installation ID not found in Vercel integration");
    }

    try {
      await client.integrations.deleteConfiguration({
        id: secret.installationId,
      });
    } catch (error) {
      logger.error("Failed to uninstall Vercel integration", {
        installationId: secret.installationId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }
}

