import { Vercel } from "@vercel/sdk";
import {
  Organization,
  OrganizationIntegration,
  SecretReference,
} from "@trigger.dev/database";
import { z } from "zod";
import { $transaction, prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import {
  SyncEnvVarsMapping,
  shouldSyncEnvVar,
  TriggerEnvironmentType,
  envTypeToVercelTarget,
} from "~/v3/vercel/vercelProjectIntegrationSchema";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";

function normalizeTarget(target: unknown): string[] {
  if (Array.isArray(target)) return target.filter(Boolean) as string[];
  if (typeof target === 'string') return [target];
  return [];
}

function extractEnvs(response: unknown): unknown[] {
  if (response && typeof response === 'object' && 'envs' in response) {
    const envs = (response as { envs: unknown }).envs;
    return Array.isArray(envs) ? envs : [];
  }
  return [];
}

function isVercelSecretType(type: string): boolean {
  return type === "secret" || type === "sensitive" || type === "encrypted";
}

function vercelApiError(message: string, context: Record<string, unknown>, error: unknown): VercelAPIResult<never> {
  const authInvalid = isVercelAuthError(error);
  logger.error(message, { ...context, error, authInvalid });
  return {
    success: false,
    authInvalid,
    error: error instanceof Error ? error.message : "Unknown error",
  };
}

export const VercelSecretSchema = z.object({
  accessToken: z.string(),
  tokenType: z.string().optional(),
  teamId: z.string().nullable().optional(),
  userId: z.string().optional(),
  installationId: z.string().optional(),
  raw: z.record(z.any()).optional(),
});

export type VercelSecret = z.infer<typeof VercelSecretSchema>;

export type TokenResponse = {
  accessToken: string;
  tokenType: string;
  teamId?: string;
  userId?: string;
  raw: Record<string, unknown>;
};

export type VercelEnvironmentVariable = {
  id: string;
  key: string;
  type: "system" | "encrypted" | "plain" | "sensitive" | "secret";
  isSecret: boolean;
  target: string[];
  isShared?: boolean;
};

export type VercelCustomEnvironment = {
  id: string;
  slug: string;
  description?: string;
  branchMatcher?: {
    pattern: string;
    type: string;
  };
};

export type VercelAPIResult<T> = {
  success: true;
  data: T;
} | {
  success: false;
  authInvalid: boolean;
  error: string;
};

const VercelErrorSchema = z.union([
  z.object({ status: z.number() }),
  z.object({ response: z.object({ status: z.number() }) }),
  z.object({ statusCode: z.number() }),
]);

function extractVercelErrorStatus(error: unknown): number | null {
  if (error && typeof error === 'object' && 'status' in error) {
    const parsed = VercelErrorSchema.safeParse(error);
    if (parsed.success && 'status' in parsed.data) {
      return parsed.data.status;
    }
  }

  if (error && typeof error === 'object' && 'response' in error) {
    const parsed = VercelErrorSchema.safeParse(error);
    if (parsed.success && 'response' in parsed.data) {
      return parsed.data.response.status;
    }
  }

  if (error && typeof error === 'object' && 'statusCode' in error) {
    const parsed = VercelErrorSchema.safeParse(error);
    if (parsed.success && 'statusCode' in parsed.data) {
      return parsed.data.statusCode;
    }
  }

  if (typeof error === 'string') {
    if (error.includes('401')) return 401;
    if (error.includes('403')) return 403;
  }

  return null;
}

function isVercelAuthError(error: unknown): boolean {
  const status = extractVercelErrorStatus(error);
  return status === 401 || status === 403;
}

export class VercelIntegrationRepository {
  static async exchangeCodeForToken(code: string): Promise<TokenResponse | null> {
    const clientId = env.VERCEL_INTEGRATION_CLIENT_ID;
    const clientSecret = env.VERCEL_INTEGRATION_CLIENT_SECRET;
    const redirectUri = `${env.APP_ORIGIN}/vercel/callback`;

    if (!clientId || !clientSecret) {
      logger.error("Vercel integration not configured");
      return null;
    }

    try {
      const response = await fetch("https://api.vercel.com/v2/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("Failed to exchange Vercel OAuth code", {
          status: response.status,
          error: errorText,
        });
        return null;
      }

      const data = (await response.json()) as {
        access_token: string;
        token_type: string;
        team_id?: string;
        user_id?: string;
      };

      return {
        accessToken: data.access_token,
        tokenType: data.token_type,
        teamId: data.team_id,
        userId: data.user_id,
        raw: data as Record<string, unknown>,
      };
    } catch (error) {
      logger.error("Error exchanging Vercel OAuth code", { error });
      return null;
    }
  }

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

  static async validateVercelToken(
    integration: OrganizationIntegration & { tokenReference: SecretReference }
  ): Promise<{ isValid: boolean }> {
    try {
      const client = await this.getVercelClient(integration);
      await client.user.getAuthUser();
      return { isValid: true };
    } catch (error) {
      const authInvalid = isVercelAuthError(error);
      if (authInvalid) {
        logger.debug("Vercel token validation failed - auth error", {
          integrationId: integration.id,
          error,
        });
        return { isValid: false };
      }
      logger.error("Vercel token validation failed - unexpected error", {
        integrationId: integration.id,
        error,
      });
      throw error;
    }
  }

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

  static async getVercelIntegrationConfiguration(
    accessToken: string,
    configurationId: string,
    teamId?: string | null
  ): Promise<{
    id: string;
    teamId: string | null;
    projects: string[];
  } | null> {
    try {
      const client = new Vercel({
        bearerToken: accessToken,
      });

      const response = await fetch(
        `https://api.vercel.com/v1/integrations/configuration/${configurationId}${teamId ? `?teamId=${teamId}` : ""}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("Failed to fetch Vercel integration configuration", {
          status: response.status,
          error: errorText,
          configurationId,
          teamId,
        });
        return null;
      }

      const data = (await response.json()) as {
        id: string;
        teamId?: string | null;
        projects?: string[];
        [key: string]: any;
      };

      return {
        id: data.id,
        teamId: data.teamId ?? null,
        projects: data.projects || [],
      };
    } catch (error) {
      logger.error("Error fetching Vercel integration configuration", {
        configurationId,
        teamId,
        error,
      });
      return null;
    }
  }

  static async getVercelCustomEnvironments(
    client: Vercel,
    projectId: string,
    teamId?: string | null
  ): Promise<VercelAPIResult<VercelCustomEnvironment[]>> {
    try {
      const response = await client.environment.getV9ProjectsIdOrNameCustomEnvironments({
        idOrName: projectId,
        ...(teamId && { teamId }),
      });

      const environments = response.environments || [];

      return {
        success: true,
        data: environments.map((env: any) => ({
          id: env.id,
          slug: env.slug,
          description: env.description,
          branchMatcher: env.branchMatcher,
        })),
      };
    } catch (error) {
      return vercelApiError("Failed to fetch Vercel custom environments", { projectId, teamId }, error);
    }
  }

  static async getVercelEnvironmentVariables(
    client: Vercel,
    projectId: string,
    teamId?: string | null,
  ): Promise<VercelAPIResult<VercelEnvironmentVariable[]>> {
    try {
      const response = await client.projects.filterProjectEnvs({
        idOrName: projectId,
        ...(teamId && { teamId }),
      });

      const envs = extractEnvs(response);

      return {
        success: true,
        data: envs.map((env: any) => {
          const type = env.type as VercelEnvironmentVariable["type"];

          return {
            id: env.id,
            key: env.key,
            type,
            isSecret: isVercelSecretType(type),
            target: normalizeTarget(env.target),
            customEnvironmentIds: env.customEnvironmentIds as string[] ?? [],
          };
        }),
      };
    } catch (error) {
      return vercelApiError("Failed to fetch Vercel environment variables", { projectId, teamId }, error);
    }
  }

  static async getVercelEnvironmentVariableValues(
    client: Vercel,
    projectId: string,
    teamId?: string | null,
    target?: string
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

      const envs = extractEnvs(response);

      const result = envs
        .filter((env: any) => {
          if (!env.value) {
            return false;
          }
          if (target) {
            return normalizeTarget(env.target).includes(target);
          }
          return true;
        })
        .map((env: any) => {
          const type = env.type as string;

          return {
            key: env.key as string,
            value: env.value as string,
            target: normalizeTarget(env.target),
            type,
            isSecret: isVercelSecretType(type),
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

  static async getVercelSharedEnvironmentVariables(
    client: Vercel,
    teamId: string,
    projectId?: string // Optional: filter by project
  ): Promise<VercelAPIResult<Array<{
      id: string;
      key: string;
      type: string;
      isSecret: boolean;
      target: string[];
    }>>> {
    try {
      const response = await client.environment.listSharedEnvVariable({
        teamId,
        ...(projectId && { projectId }),
      });

      const envVars = response.data || [];

      return {
        success: true,
        data: envVars.map((env) => {
          const type = (env.type as string) || "plain";

          return {
            id: env.id as string,
            key: env.key as string,
            type,
            isSecret: isVercelSecretType(type),
            target: normalizeTarget(env.target),
          };
        }),
      };
    } catch (error) {
      return vercelApiError("Failed to fetch Vercel shared environment variables", { teamId, projectId }, error);
    }
  }

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
      const listResponse = await client.environment.listSharedEnvVariable({
        teamId,
        ...(projectId && { projectId }),
      });

      const envVars = listResponse.data || [];

      if (envVars.length === 0) {
        return [];
      }

      const results = await Promise.all(
        envVars.map(async (env) => {
          const type = (env.type as string) || "plain";
          const isSecret = isVercelSecretType(type);

          if (isSecret) {
            return null;
          }

          const listValue = (env as any).value as string | undefined;
          const applyToAllCustomEnvs = (env as any).applyToAllCustomEnvironments as boolean | undefined;

          if (listValue) {
            return {
              key: env.key as string,
              value: listValue,
              target: normalizeTarget(env.target),
              type,
              isSecret,
              applyToAllCustomEnvironments: applyToAllCustomEnvs,
            };
          }

          try {
            // Get the decrypted value for this shared env var
            const getResponse = await client.environment.getSharedEnvVar({
              id: env.id as string,
              teamId,
            });

            if (!getResponse.value) {
              return null;
            }

            const result = {
              key: env.key as string,
              value: getResponse.value as string,
              target: normalizeTarget(env.target),
              type,
              isSecret,
              applyToAllCustomEnvironments: (env as any).applyToAllCustomEnvironments as boolean | undefined,
            };

            return result;
          } catch (error) {
            // Workaround: Vercel SDK may throw ResponseValidationError even when the API response
            // is valid (e.g., deletedAt: null vs expected number). Extract value from rawValue.
            let errorValue: string | undefined;
            if (error && typeof error === "object" && "rawValue" in error) {
              const rawValue = (error as any).rawValue;
              if (rawValue && typeof rawValue === "object" && "value" in rawValue) {
                errorValue = rawValue.value as string | undefined;
              }
            }

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
                target: normalizeTarget(env.target),
                type,
                isSecret,
                applyToAllCustomEnvironments: applyToAllCustomEnvs,
              };
            }

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

      const validResults = results.filter((r): r is NonNullable<typeof r> => r !== null);

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

  static async getVercelProjects(
    client: Vercel,
    teamId?: string | null
  ): Promise<VercelAPIResult<Array<{ id: string; name: string }>>> {
    try {
      const response = await client.projects.getProjects({
        ...(teamId && { teamId }),
      });

      const projects = response.projects || [];

      return {
        success: true,
        data: projects.map((project: any) => ({
          id: project.id,
          name: project.name,
        })),
      };
    } catch (error) {
      return vercelApiError("Failed to fetch Vercel projects", { teamId }, error);
    }
  }

  static async updateVercelOrgIntegrationToken(params: {
    integrationId: string;
    accessToken: string;
    tokenType?: string;
    teamId: string | null;
    userId?: string;
    installationId?: string;
    raw?: Record<string, any>;
  }): Promise<void> {
    await $transaction(prisma, async (tx) => {
      const integration = await tx.organizationIntegration.findUnique({
        where: { id: params.integrationId },
        include: { tokenReference: true },
      });

      if (!integration) {
        throw new Error("Vercel integration not found");
      }

      const secretStore = getSecretStore(integration.tokenReference.provider, {
        prismaClient: tx,
      });

      const secretValue: VercelSecret = {
        accessToken: params.accessToken,
        tokenType: params.tokenType,
        teamId: params.teamId,
        userId: params.userId,
        installationId: params.installationId,
        raw: params.raw,
      };

      await secretStore.setSecret(integration.tokenReference.key, secretValue);

      await tx.organizationIntegration.update({
        where: { id: params.integrationId },
        data: {
          integrationData: {
            teamId: params.teamId,
            userId: params.userId,
            installationId: params.installationId,
          } as any,
        },
      });
    });
  }

  static async createVercelOrgIntegration(params: {
    accessToken: string;
    tokenType?: string;
    teamId: string | null;
    userId?: string;
    installationId?: string;
    organization: Pick<Organization, "id">;
    raw?: Record<string, any>;
    origin: 'marketplace' | 'dashboard';
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
            origin: params.origin,
          } as any,
        },
      });
    });

    if (!result) {
      throw new Error("Failed to create Vercel organization integration");
    }

    return result;
  }

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

  static async syncApiKeysToVercel(params: {
    projectId: string;
    vercelProjectId: string;
    teamId: string | null;
    vercelStagingEnvironment?: { environmentId: string; displayName: string } | null;
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
        const vercelTarget = envTypeToVercelTarget(
          env.type as TriggerEnvironmentType,
          params.vercelStagingEnvironment?.environmentId
        );

        if (!vercelTarget) {
          continue;
        }

        envVarsToSync.push({
          key: "TRIGGER_SECRET_KEY",
          value: env.apiKey,
          target: vercelTarget,
          type: "encrypted",
          environmentType: env.type,
        });
      }

      if (envVarsToSync.length === 0) {
        return { success: true, errors: [] };
      }

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

  static async syncSingleApiKeyToVercel(params: {
    projectId: string;
    environmentType: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT";
    apiKey: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
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
        return { success: true };
      }

      const orgIntegration = projectIntegration.organizationIntegration;
      const client = await this.getVercelClient(orgIntegration);
      const teamId = await this.getTeamIdFromIntegration(orgIntegration);

      const integrationData = projectIntegration.integrationData as any;
      const vercelStagingEnvironment = integrationData?.config?.vercelStagingEnvironment;

      const vercelTarget = envTypeToVercelTarget(
        params.environmentType,
        vercelStagingEnvironment?.environmentId
      );

      if (!vercelTarget) {
        return { success: true };
      }

      await this.upsertVercelEnvVar({
        client,
        vercelProjectId: projectIntegration.externalEntityId,
        teamId,
        key: "TRIGGER_SECRET_KEY",
        value: params.apiKey,
        target: vercelTarget,
        type: "encrypted",
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

  static async pullEnvVarsFromVercel(params: {
    projectId: string;
    vercelProjectId: string;
    teamId: string | null;
    vercelStagingEnvironment?: { environmentId: string; displayName: string } | null;
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

      const envMapping: Array<{
        triggerEnvType: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT";
        vercelTarget: string;
        runtimeEnvironmentId: string;
      }> = [];

      for (const env of runtimeEnvironments) {
        const vercelTarget = envTypeToVercelTarget(
          env.type as TriggerEnvironmentType,
          params.vercelStagingEnvironment?.environmentId
        );

        if (!vercelTarget) {
          continue;
        }

        envMapping.push({
          triggerEnvType: env.type as "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT",
          vercelTarget: vercelTarget[0],
          runtimeEnvironmentId: env.id,
        });
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
        sharedEnvVars = await this.getVercelSharedEnvironmentVariableValues(
          client,
          params.teamId,
          params.vercelProjectId
        );
      }

      // Process each environment mapping
      for (const mapping of envMapping) {
        try {
          const projectEnvVars = await this.getVercelEnvironmentVariableValues(
            client,
            params.vercelProjectId,
            params.teamId,
            mapping.vercelTarget
          );

          const standardTargets = ["production", "preview", "development"];
          const isCustomEnvironment = !standardTargets.includes(mapping.vercelTarget);

          const filteredSharedEnvVars = sharedEnvVars.filter((envVar) => {
            const matchesTarget = envVar.target.includes(mapping.vercelTarget);
            const matchesCustomEnv = isCustomEnvironment && envVar.applyToAllCustomEnvironments === true;
            return matchesTarget || matchesCustomEnv;
          });

          const projectEnvVarKeys = new Set(projectEnvVars.map((v) => v.key));
          const sharedEnvVarsToAdd = filteredSharedEnvVars.filter((v) => !projectEnvVarKeys.has(v.key));
          const mergedEnvVars = [
            ...projectEnvVars,
            ...sharedEnvVarsToAdd,
          ];

          if (mergedEnvVars.length === 0) {
            continue;
          }

          const varsToSync = mergedEnvVars.filter((envVar) => {
            if (envVar.isSecret) {
              return false;
            }
            if (envVar.key === "TRIGGER_SECRET_KEY") {
              return false;
            }
            return shouldSyncEnvVar(
              params.syncEnvVarsMapping,
              envVar.key,
              mapping.triggerEnvType as TriggerEnvironmentType
            );
          });

          if (varsToSync.length === 0) {
            continue;
          }

          const existingSecretKeys = new Set<string>();
          const existingValues = new Map<string, string>();

          const existingVarValues = await prisma.environmentVariableValue.findMany({
            where: {
              environmentId: mapping.runtimeEnvironmentId,
              variable: {
                projectId: params.projectId,
                key: {
                  in: varsToSync.map((v) => v.key),
                },
              },
            },
            select: {
              isSecret: true,
              valueReference: {
                select: {
                  key: true,
                },
              },
              variable: {
                select: {
                  key: true,
                },
              },
            },
          });

          if (existingVarValues.length > 0) {
            const secretStore = getSecretStore("DATABASE", { prismaClient: prisma });
            const SecretValue = z.object({ secret: z.string() });

            for (const varValue of existingVarValues) {
              if (varValue.isSecret) {
                existingSecretKeys.add(varValue.variable.key);
              }

              if (varValue.valueReference?.key) {
                try {
                  const existingSecret = await secretStore.getSecret(SecretValue, varValue.valueReference.key);
                  if (existingSecret) {
                    existingValues.set(varValue.variable.key, existingSecret.secret);
                  }
                } catch {
                  // If we can't read the existing value, we'll update it anyway
                }
              }
            }
          }

          const changedVars = varsToSync.filter((v) => {
            const existingValue = existingValues.get(v.key);
            return existingValue === undefined || existingValue !== v.value;
          });

          if (changedVars.length === 0) {
            continue;
          }

          const secretVars = changedVars.filter((v) => existingSecretKeys.has(v.key));
          const nonSecretVars = changedVars.filter((v) => !existingSecretKeys.has(v.key));

          if (nonSecretVars.length > 0) {
            const result = await envVarRepository.create(params.projectId, {
              override: true,
              environmentIds: [mapping.runtimeEnvironmentId],
              isSecret: false,
              variables: nonSecretVars.map((v) => ({
                key: v.key,
                value: v.value,
              })),
              lastUpdatedBy: {
                type: "integration",
                integration: "vercel",
              },
            });

            if (result.success) {
              syncedCount += nonSecretVars.length;
            } else {
              const errorMsg = `Failed to sync env vars for ${mapping.triggerEnvType}: ${result.error}`;
              errors.push(errorMsg);
              logger.error(errorMsg, {
                projectId: params.projectId,
                vercelProjectId: params.vercelProjectId,
                vercelTarget: mapping.vercelTarget,
                error: result.error,
                variableErrors: result.variableErrors,
                attemptedKeys: nonSecretVars.map((v) => v.key),
              });
            }
          }

          if (secretVars.length > 0) {
            const result = await envVarRepository.create(params.projectId, {
              override: true,
              environmentIds: [mapping.runtimeEnvironmentId],
              isSecret: true,
              variables: secretVars.map((v) => ({
                key: v.key,
                value: v.value,
              })),
              lastUpdatedBy: {
                type: "integration",
                integration: "vercel",
              },
            });

            if (result.success) {
              syncedCount += secretVars.length;
            } else {
              const errorMsg = `Failed to sync secret env vars for ${mapping.triggerEnvType}: ${result.error}`;
              errors.push(errorMsg);
              logger.error(errorMsg, {
                projectId: params.projectId,
                vercelProjectId: params.vercelProjectId,
                vercelTarget: mapping.vercelTarget,
                error: result.error,
                variableErrors: result.variableErrors,
                attemptedKeys: secretVars.map((v) => v.key),
              });
            }
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

    const existingEnvs = await client.projects.filterProjectEnvs({
      idOrName: vercelProjectId,
      ...(teamId && { teamId }),
    });

    const existingEnvsList =
      "envs" in existingEnvs && Array.isArray(existingEnvs.envs) ? existingEnvs.envs : [];

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
      const existingEnv = existingEnvsList.find((env: any) => {
        if (env.key !== envVar.key) {
          return false;
        }
        const envTargets = normalizeTarget(env.target);
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

    const existingEnvs = await client.projects.filterProjectEnvs({
      idOrName: vercelProjectId,
      ...(teamId && { teamId }),
    });

    const envs = "envs" in existingEnvs && Array.isArray(existingEnvs.envs) 
      ? existingEnvs.envs 
      : [];

    // Vercel can have multiple env vars with the same key but different targets
    const existingEnv = envs.find((env: any) => {
      if (env.key !== key) {
        return false;
      }
      const envTargets = normalizeTarget(env.target);
      return target.length === envTargets.length && target.every((t) => envTargets.includes(t));
    });

    if (existingEnv && existingEnv.id) {
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

  static async getAutoAssignCustomDomains(
    client: Vercel,
    vercelProjectId: string,
    teamId?: string | null
  ): Promise<boolean | null> {
    try {
      // Vercel SDK lacks a getProject method — updateProject with empty body reads without modifying.
      const project = await client.projects.updateProject({
        idOrName: vercelProjectId,
        ...(teamId && { teamId }),
        requestBody: {},
      });

      return project.autoAssignCustomDomains ?? null;
    } catch (error) {
      logger.error("Failed to get Vercel project autoAssignCustomDomains", {
        vercelProjectId,
        teamId,
        error,
      });
      return null;
    }
  }

  /** Disable autoAssignCustomDomains — required for atomic deployments. */
  static async disableAutoAssignCustomDomains(
    client: Vercel,
    vercelProjectId: string,
    teamId?: string | null
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await client.projects.updateProject({
        idOrName: vercelProjectId,
        ...(teamId && { teamId }),
        requestBody: {
          autoAssignCustomDomains: false,
        },
      });

      return { success: true };
    } catch (error) {
      const errorMessage = `Failed to disable autoAssignCustomDomains: ${error instanceof Error ? error.message : "Unknown error"}`;
      logger.error(errorMessage, {
        vercelProjectId,
        teamId,
        error,
      });
      return { success: false, error: errorMessage };
    }
  }

  static async uninstallVercelIntegration(
    integration: OrganizationIntegration & { tokenReference: SecretReference }
  ): Promise<{ authInvalid: boolean }> {
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
      return { authInvalid: false };
    } catch (error) {
      const isAuthError = isVercelAuthError(error);
      logger.error("Failed to uninstall Vercel integration", {
        installationId: secret.installationId,
        error: error instanceof Error ? error.message : "Unknown error",
        isAuthError,
      });
      // Auth errors (401/403): still clean up on our side, return flag for caller
      if (isAuthError) {
        return { authInvalid: true };
      }
      throw error;
    }
  }
}

