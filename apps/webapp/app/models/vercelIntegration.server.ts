import pLimit from "p-limit";
import { Vercel } from "@vercel/sdk";
import type {
  ResponseBodyEnvs,
  FilterProjectEnvsResponseBody,
} from "@vercel/sdk/models/filterprojectenvsop";
import type {
  GetV9ProjectsIdOrNameCustomEnvironmentsEnvironments,
} from "@vercel/sdk/models/getv9projectsidornamecustomenvironmentsop";
import type { ResponseBodyProjects } from "@vercel/sdk/models/getprojectsop";
import {
  Organization,
  OrganizationIntegration,
  SecretReference,
} from "@trigger.dev/database";
import { z } from "zod";
import { ResultAsync, errAsync, okAsync } from "neverthrow";
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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function normalizeTarget(target: string[] | string | undefined): string[] {
  if (Array.isArray(target)) return target.filter(Boolean);
  if (typeof target === 'string') return [target];
  return [];
}

function extractVercelEnvs(
  response: FilterProjectEnvsResponseBody
): ResponseBodyEnvs[] {
  if ("envs" in response && Array.isArray(response.envs)) {
    return response.envs;
  }
  return [];
}

function isVercelSecretType(type: string): boolean {
  return type === "secret" || type === "sensitive";
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

export type VercelApiError = {
  message: string;
  authInvalid: boolean;
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

function toVercelApiError(error: unknown): VercelApiError {
  if (isVercelApiErrorShape(error)) return error;
  return {
    message: error instanceof Error ? error.message : "Unknown error",
    authInvalid: isVercelAuthError(error),
  };
}

function isVercelApiErrorShape(error: unknown): error is VercelApiError {
  return (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    "authInvalid" in error &&
    typeof (error as VercelApiError).message === "string" &&
    typeof (error as VercelApiError).authInvalid === "boolean"
  );
}

/**
 * Wrap a Vercel SDK call in ResultAsync with structured error logging.
 */
function wrapVercelCall<T>(
  promise: Promise<T>,
  message: string,
  context: Record<string, unknown>
): ResultAsync<T, VercelApiError> {
  return ResultAsync.fromPromise(promise, (error) => {
    const apiError = toVercelApiError(error);
    logger.error(message, { ...context, error, authInvalid: apiError.authInvalid });
    return apiError;
  });
}

// ---------------------------------------------------------------------------
// Schemas & token types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Domain types narrowed from Vercel SDK response types.
//
// Using Pick and indexed-access types ties these definitions to the SDK so
// that any upstream type change surfaces as a compile error here rather than
// silently breaking at runtime.
// ---------------------------------------------------------------------------

/** Narrowed env-var type from the SDK's FilterProjectEnvs response. */
export type VercelEnvironmentVariable = {
  id: string; // narrowed from ResponseBodyEnvs["id"] (string | undefined)
  key: ResponseBodyEnvs["key"];
  type: ResponseBodyEnvs["type"];
  isSecret: boolean;
  target: string[];
  isShared?: boolean;
  customEnvironmentIds: string[];
};

/** Narrowed custom-environment type – only the fields we consume. */
export type VercelCustomEnvironment = Pick<
  GetV9ProjectsIdOrNameCustomEnvironmentsEnvironments,
  "id" | "slug" | "description" | "branchMatcher"
>;

/** Narrowed env-var-with-value type from the SDK's FilterProjectEnvs response. */
export type VercelEnvironmentVariableValue = {
  key: ResponseBodyEnvs["key"];
  value: string; // narrowed from ResponseBodyEnvs["value"] – only present after null-check
  target: string[];
  type: ResponseBodyEnvs["type"];
  isSecret: boolean;
};

/** Narrowed Vercel project type – only id and name. */
export type VercelProject = Pick<ResponseBodyProjects, "id" | "name">;

// ---------------------------------------------------------------------------
// Mapper functions – narrow wide SDK responses into our domain types.
// ---------------------------------------------------------------------------

function toVercelEnvironmentVariable(
  env: ResponseBodyEnvs
): VercelEnvironmentVariable {
  return {
    id: env.id ?? "",
    key: env.key,
    type: env.type,
    isSecret: isVercelSecretType(env.type),
    target: normalizeTarget(env.target),
    customEnvironmentIds: env.customEnvironmentIds ?? [],
  };
}

function toVercelCustomEnvironment({
  id,
  slug,
  description,
  branchMatcher,
}: GetV9ProjectsIdOrNameCustomEnvironmentsEnvironments): VercelCustomEnvironment {
  return { id, slug, description, branchMatcher };
}

function toVercelEnvironmentVariableValue(
  env: ResponseBodyEnvs
): VercelEnvironmentVariableValue | null {
  if (!env.value) return null;
  return {
    key: env.key,
    value: env.value,
    target: normalizeTarget(env.target),
    type: env.type,
    isSecret: isVercelSecretType(env.type),
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class VercelIntegrationRepository {
  static exchangeCodeForToken(code: string): ResultAsync<TokenResponse, VercelApiError> {
    const clientId = env.VERCEL_INTEGRATION_CLIENT_ID;
    const clientSecret = env.VERCEL_INTEGRATION_CLIENT_SECRET;
    const redirectUri = `${env.APP_ORIGIN}/vercel/callback`;

    if (!clientId || !clientSecret) {
      logger.error("Vercel integration not configured");
      return errAsync({ message: "Vercel integration not configured", authInvalid: false });
    }

    return ResultAsync.fromPromise(
      fetch("https://api.vercel.com/v2/oauth/access_token", {
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
      }).then(async (response) => {
        if (!response.ok) {
          const errorText = await response.text();
          logger.error("Failed to exchange Vercel OAuth code", {
            status: response.status,
            error: errorText,
          });
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        return response.json() as Promise<{
          access_token: string;
          token_type: string;
          team_id?: string;
          user_id?: string;
        }>;
      }),
      (error) => {
        logger.error("Error exchanging Vercel OAuth code", { error });
        return toVercelApiError(error);
      }
    ).map((data): TokenResponse => ({
      accessToken: data.access_token,
      tokenType: data.token_type,
      teamId: data.team_id,
      userId: data.user_id,
      raw: data as Record<string, unknown>,
    }));
  }

  static getVercelClient(
    integration: OrganizationIntegration & { tokenReference: SecretReference }
  ): ResultAsync<Vercel, VercelApiError> {
    return ResultAsync.fromPromise(
      (async () => {
        const secretStore = getSecretStore(integration.tokenReference.provider);
        const secret = await secretStore.getSecret(
          VercelSecretSchema,
          integration.tokenReference.key
        );
        if (!secret) {
          throw new Error("Failed to get Vercel access token");
        }
        return new Vercel({ bearerToken: secret.accessToken });
      })(),
      (error) => toVercelApiError(error)
    );
  }

  static getTeamSlug(
    client: Vercel,
    teamId: string | null
  ): ResultAsync<string, VercelApiError> {
    if (teamId) {
      return wrapVercelCall(
        client.teams.getTeam({ teamId }),
        "Failed to fetch Vercel team",
        { teamId }
      ).map((response) => response.slug);
    }

    return wrapVercelCall(
      client.user.getAuthUser(),
      "Failed to fetch Vercel user",
      {}
    ).map((response) => response?.user.username ?? "unknown");
  }

  static validateVercelToken(
    integration: OrganizationIntegration & { tokenReference: SecretReference }
  ): ResultAsync<{ isValid: boolean }, VercelApiError> {
    return this.getVercelClient(integration)
      .andThen((client) =>
        ResultAsync.fromPromise(
          client.user.getAuthUser(),
          toVercelApiError
        )
      )
      .map(() => ({ isValid: true }))
      .orElse((error) =>
        error.authInvalid
          ? okAsync({ isValid: false })
          : errAsync(error)
      );
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

  static getVercelIntegrationConfiguration(
    accessToken: string,
    configurationId: string,
    teamId?: string | null
  ): ResultAsync<{
    id: string;
    teamId: string | null;
    projects: string[];
  }, VercelApiError> {
    return ResultAsync.fromPromise(
      fetch(
        `https://api.vercel.com/v1/integrations/configuration/${configurationId}${teamId ? `?teamId=${teamId}` : ""}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      ).then(async (response) => {
        if (!response.ok) {
          const errorText = await response.text();
          logger.error("Failed to fetch Vercel integration configuration", {
            status: response.status,
            error: errorText,
            configurationId,
            teamId,
          });
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        return response.json() as Promise<{
          id: string;
          teamId?: string | null;
          projects?: string[];
          [key: string]: any;
        }>;
      }),
      (error) => {
        logger.error("Error fetching Vercel integration configuration", {
          configurationId,
          teamId,
          error,
        });
        return toVercelApiError(error);
      }
    ).map((data) => ({
      id: data.id,
      teamId: data.teamId ?? null,
      projects: data.projects || [],
    }));
  }

  static getVercelCustomEnvironments(
    client: Vercel,
    projectId: string,
    teamId?: string | null
  ): ResultAsync<VercelCustomEnvironment[], VercelApiError> {
    return wrapVercelCall(
      client.environment.getV9ProjectsIdOrNameCustomEnvironments({
        idOrName: projectId,
        ...(teamId && { teamId }),
      }),
      "Failed to fetch Vercel custom environments",
      { projectId, teamId }
    ).map((response) => (response.environments || []).map(toVercelCustomEnvironment));
  }

  static getVercelEnvironmentVariables(
    client: Vercel,
    projectId: string,
    teamId?: string | null,
  ): ResultAsync<VercelEnvironmentVariable[], VercelApiError> {
    return wrapVercelCall(
      client.projects.filterProjectEnvs({
        idOrName: projectId,
        ...(teamId && { teamId }),
      }),
      "Failed to fetch Vercel environment variables",
      { projectId, teamId }
    ).map((response) => {
      // Warn if response is paginated (more data exists that we're not fetching)
      if (
        "pagination" in response &&
        response.pagination &&
        "next" in response.pagination &&
        response.pagination.next !== null
      ) {
        logger.warn(
          "Vercel filterProjectEnvs returned paginated response - some env vars may be missing",
          { projectId, count: response.pagination.count }
        );
      }
      return extractVercelEnvs(response).map(toVercelEnvironmentVariable);
    });
  }

  static getVercelEnvironmentVariableValues(
    client: Vercel,
    projectId: string,
    teamId?: string | null,
    target?: string,
    /** If provided, only include keys that pass this filter */
    shouldIncludeKey?: (key: string) => boolean
  ): ResultAsync<VercelEnvironmentVariableValue[], VercelApiError> {
    return wrapVercelCall(
      client.projects.filterProjectEnvs({
        idOrName: projectId,
        ...(teamId && { teamId }),
      }),
      "Failed to fetch Vercel environment variable values",
      { projectId, teamId, target }
    ).andThen((response) => {
      // Apply all filters BEFORE decryption to avoid unnecessary API calls
      const filteredEnvs = extractVercelEnvs(response).filter((env) => {
        if (target && !normalizeTarget(env.target).includes(target)) return false;
        if (shouldIncludeKey && !shouldIncludeKey(env.key)) return false;
        if (isVercelSecretType(env.type)) return false;
        return true;
      });

      // Fetch decrypted values for encrypted vars, use list values for others
      const concurrencyLimit = pLimit(5);
      return ResultAsync.fromPromise(
        Promise.all(
          filteredEnvs.map((env) =>
            concurrencyLimit(() => this.#resolveEnvVarValue(client, projectId, teamId, env))
          )
        ),
        (error) => toVercelApiError(error)
      ).map((results) => results.filter((v): v is VercelEnvironmentVariableValue => v !== null));
    });
  }

  static async #resolveEnvVarValue(
    client: Vercel,
    projectId: string,
    teamId: string | null | undefined,
    env: ResponseBodyEnvs
  ): Promise<VercelEnvironmentVariableValue | null> {
    // Non-encrypted vars: use value from list response if present
    if (env.type !== "encrypted" || !env.id) {
      if (env.value === undefined || env.value === null) return null;
      return toVercelEnvironmentVariableValue(env);
    }

    // Encrypted vars: fetch decrypted value via individual endpoint
    // (list endpoint's decrypt param is deprecated)
    const result = await ResultAsync.fromPromise(
      client.projects.getProjectEnv({
        idOrName: projectId,
        id: env.id,
        ...(teamId && { teamId }),
      }),
      (error) => error
    );

    if (result.isErr()) {
      logger.warn("Failed to decrypt Vercel env var", {
        projectId,
        envVarKey: env.key,
        error: result.error instanceof Error ? result.error.message : String(result.error),
      });
      return null;
    }

    // API returns union: ResponseBody1 has no value, ResponseBody2/3 have value
    const decryptedValue = (result.value as { value?: string }).value;
    if (typeof decryptedValue !== "string") return null;

    return {
      key: env.key,
      value: decryptedValue,
      target: normalizeTarget(env.target),
      type: env.type,
      isSecret: false,
    };
  }

  static getVercelSharedEnvironmentVariables(
    client: Vercel,
    teamId: string,
    projectId?: string // Optional: filter by project
  ): ResultAsync<Array<{
      id: string;
      key: string;
      type: string;
      isSecret: boolean;
      target: string[];
    }>, VercelApiError> {
    return wrapVercelCall(
      client.environment.listSharedEnvVariable({
        teamId,
        ...(projectId && { projectId }),
      }),
      "Failed to fetch Vercel shared environment variables",
      { teamId, projectId }
    ).map((response) => {
      const envVars = response.data || [];
      return envVars
        .filter((env): env is typeof env & { id: string; key: string } =>
          typeof env.id === "string" && typeof env.key === "string"
        )
        .map((env) => {
          const type = env.type || "plain";
          return {
            id: env.id,
            key: env.key,
            type,
            isSecret: isVercelSecretType(type),
            target: normalizeTarget(env.target),
          };
        });
    });
  }

  static getVercelSharedEnvironmentVariableValues(
    client: Vercel,
    teamId: string,
    projectId?: string // Optional: filter by project
  ): ResultAsync<
    Array<{
      key: string;
      value: string;
      target: string[];
      type: string;
      isSecret: boolean;
      applyToAllCustomEnvironments?: boolean;
    }>,
    VercelApiError
  > {
    return wrapVercelCall(
      client.environment.listSharedEnvVariable({
        teamId,
        ...(projectId && { projectId }),
      }),
      "Failed to fetch Vercel shared environment variable values",
      { teamId, projectId }
    ).andThen((listResponse) => {
      const envVars = listResponse.data || [];
      if (envVars.length === 0) {
        return okAsync([]);
      }

      const concurrencyLimit = pLimit(5);
      return ResultAsync.fromPromise(
        Promise.all(
          envVars.map((env) =>
            concurrencyLimit(async () => {
              if (!env.id || !env.key) return null;

              const envId = env.id;
              const envKey = env.key;
              const type = env.type || "plain";
              const isSecret = isVercelSecretType(type);

              if (isSecret) return null;

              const listValue = (env as any).value as string | undefined;
              const applyToAllCustomEnvs = (env as any).applyToAllCustomEnvironments as boolean | undefined;

              if (listValue) {
                return {
                  key: envKey,
                  value: listValue,
                  target: normalizeTarget(env.target),
                  type,
                  isSecret,
                  applyToAllCustomEnvironments: applyToAllCustomEnvs,
                };
              }

              // Try to get the decrypted value for this shared env var
              const getResult = await ResultAsync.fromPromise(
                client.environment.getSharedEnvVar({
                  id: envId,
                  teamId,
                }),
                (error) => error
              );

              if (getResult.isOk()) {
                if (!getResult.value.value) return null;
                return {
                  key: envKey,
                  value: getResult.value.value,
                  target: normalizeTarget(env.target),
                  type,
                  isSecret,
                  applyToAllCustomEnvironments: applyToAllCustomEnvs,
                };
              }

              // Workaround: Vercel SDK may throw ResponseValidationError even when the API response
              // is valid (e.g., deletedAt: null vs expected number). Extract value from rawValue.
              const error = getResult.error;
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
                  envId,
                  envKey,
                  error: error instanceof Error ? error.message : String(error),
                  hasErrorRawValue: !!errorValue,
                  hasListValue: !!listValue,
                  valueLength: fallbackValue.length,
                });
                return {
                  key: envKey,
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
                envId,
                envKey,
                error: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
                hasRawValue: error && typeof error === "object" && "rawValue" in error,
              });
              return null;
            })
          )
        ),
        (error) => {
          logger.error("Failed to process shared environment variable values", {
            teamId,
            projectId,
            error: error instanceof Error ? error.message : String(error),
          });
          return toVercelApiError(error);
        }
      ).map((results) => results.filter((r): r is NonNullable<typeof r> => r !== null));
    });
  }

  static getVercelProjects(
    client: Vercel,
    teamId?: string | null
  ): ResultAsync<VercelProject[], VercelApiError> {
    return ResultAsync.fromPromise(
      (async () => {
        const allProjects: VercelProject[] = [];
        let from: string | undefined;

        do {
          const response = await client.projects.getProjects({
            ...(teamId && { teamId }),
            limit: "100",
            ...(from && { from }),
          });

          const projects = Array.isArray(response)
            ? response
            : "projects" in response
              ? response.projects
              : [];
          allProjects.push(...projects.map(({ id, name }): VercelProject => ({ id, name })));

          // Get pagination token for next page
          const pagination =
            !Array.isArray(response) && "pagination" in response
              ? response.pagination
              : undefined;
          from =
            pagination && "next" in pagination && pagination.next !== null
              ? String(pagination.next)
              : undefined;
        } while (from);

        return allProjects;
      })(),
      (error) => {
        logger.error("Failed to fetch Vercel projects", { teamId, error });
        return toVercelApiError(error);
      }
    );
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

  static syncApiKeysToVercel(params: {
    projectId: string;
    vercelProjectId: string;
    teamId: string | null;
    vercelStagingEnvironment?: { environmentId: string; displayName: string } | null;
    orgIntegration: OrganizationIntegration & { tokenReference: SecretReference };
  }): ResultAsync<{ created: number; updated: number; errors: string[] }, VercelApiError> {
    return this.getVercelClient(params.orgIntegration).andThen((client) =>
      ResultAsync.fromPromise(
        (async () => {
          // Get all environments for the project (exclude DEVELOPMENT — we don't push keys to Vercel's development target)
          const environments = await prisma.runtimeEnvironment.findMany({
            where: {
              projectId: params.projectId,
              type: {
                in: ["PRODUCTION", "STAGING", "PREVIEW"],
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

          for (const runtimeEnv of environments) {
            const vercelTarget = envTypeToVercelTarget(
              runtimeEnv.type as TriggerEnvironmentType,
              params.vercelStagingEnvironment?.environmentId
            );

            if (!vercelTarget) {
              continue;
            }

            envVarsToSync.push({
              key: "TRIGGER_SECRET_KEY",
              value: runtimeEnv.apiKey,
              target: vercelTarget,
              type: "encrypted",
              environmentType: runtimeEnv.type,
            });
          }

          if (envVarsToSync.length === 0) {
            return { created: 0, updated: 0, errors: [] as string[] };
          }

          const result = await this.batchUpsertVercelEnvVars({
            client,
            vercelProjectId: params.vercelProjectId,
            teamId: params.teamId,
            envVars: envVarsToSync,
          });

          logger.info("Synced API keys to Vercel", {
            projectId: params.projectId,
            vercelProjectId: params.vercelProjectId,
            syncedCount: result.created + result.updated,
            created: result.created,
            updated: result.updated,
            errors: result.errors,
          });

          return result;
        })(),
        (error) => {
          logger.error("Failed to sync API keys to Vercel", {
            projectId: params.projectId,
            vercelProjectId: params.vercelProjectId,
            error,
          });
          return toVercelApiError(error);
        }
      )
    );
  }

  static syncSingleApiKeyToVercel(params: {
    projectId: string;
    environmentType: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT";
    apiKey: string;
  }): ResultAsync<void, VercelApiError> {
    return ResultAsync.fromPromise(
      (async () => {
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
          return; // No integration, nothing to sync
        }

        const orgIntegration = projectIntegration.organizationIntegration;
        const clientResult = await this.getVercelClient(orgIntegration);
        if (clientResult.isErr()) throw clientResult.error;
        const client = clientResult.value;

        const teamId = await this.getTeamIdFromIntegration(orgIntegration);

        const integrationData = projectIntegration.integrationData as any;
        const vercelStagingEnvironment = integrationData?.config?.vercelStagingEnvironment;

        const vercelTarget = envTypeToVercelTarget(
          params.environmentType,
          vercelStagingEnvironment?.environmentId
        );

        if (!vercelTarget) {
          return;
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
      })(),
      (error) => {
        logger.error("Failed to sync API key to Vercel", {
          projectId: params.projectId,
          environmentType: params.environmentType,
          error,
        });
        return toVercelApiError(error);
      }
    );
  }

  static pullEnvVarsFromVercel(params: {
    projectId: string;
    vercelProjectId: string;
    teamId: string | null;
    vercelStagingEnvironment?: { environmentId: string; displayName: string } | null;
    syncEnvVarsMapping: SyncEnvVarsMapping;
    orgIntegration: OrganizationIntegration & { tokenReference: SecretReference };
  }): ResultAsync<{ syncedCount: number; errors: string[] }, VercelApiError> {
    logger.info("pullEnvVarsFromVercel: Starting", {
      projectId: params.projectId,
      vercelProjectId: params.vercelProjectId,
      teamId: params.teamId,
      vercelStagingEnvironment: params.vercelStagingEnvironment,
      syncEnvVarsMappingKeys: Object.keys(params.syncEnvVarsMapping),
    });

    return this.getVercelClient(params.orgIntegration).andThen((client) =>
      ResultAsync.fromPromise(
        (async () => {
          const errors: string[] = [];
          let syncedCount = 0;

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

          for (const runtimeEnv of runtimeEnvironments) {
            const vercelTarget = envTypeToVercelTarget(
              runtimeEnv.type as TriggerEnvironmentType,
              params.vercelStagingEnvironment?.environmentId
            );

            if (!vercelTarget) {
              continue;
            }

            envMapping.push({
              triggerEnvType: runtimeEnv.type as "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT",
              vercelTarget: vercelTarget[0],
              runtimeEnvironmentId: runtimeEnv.id,
            });
          }

          if (envMapping.length === 0) {
            logger.warn("No environments to sync for Vercel integration", {
              projectId: params.projectId,
              vercelProjectId: params.vercelProjectId,
            });
            return { syncedCount: 0, errors: [] as string[] };
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
            const sharedResult = await this.getVercelSharedEnvironmentVariableValues(
              client,
              params.teamId,
              params.vercelProjectId
            );
            sharedEnvVars = sharedResult.unwrapOr([]);
          }

          // Process each environment mapping
          for (const mapping of envMapping) {
            const iterResult = await ResultAsync.fromPromise(
              (async () => {
                // Build filter to avoid decrypting vars that will be filtered out anyway
                const excludeKeys = new Set(["TRIGGER_SECRET_KEY", "TRIGGER_VERSION"]);
                const shouldIncludeKey = (key: string) =>
                  !excludeKeys.has(key) &&
                  shouldSyncEnvVar(params.syncEnvVarsMapping, key, mapping.triggerEnvType as TriggerEnvironmentType);

                const envVarsResult = await this.getVercelEnvironmentVariableValues(
                  client,
                  params.vercelProjectId,
                  params.teamId,
                  mapping.vercelTarget,
                  shouldIncludeKey
                );

                if (envVarsResult.isErr()) {
                  logger.error("pullEnvVarsFromVercel: Failed to get env vars", {
                    triggerEnvType: mapping.triggerEnvType,
                    vercelTarget: mapping.vercelTarget,
                    error: envVarsResult.error.message,
                  });
                  errors.push(`Failed to get env vars for ${mapping.triggerEnvType}: ${envVarsResult.error.message}`);
                  return;
                }

                const projectEnvVars = envVarsResult.value;
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
                  return;
                }

                const varsToSync = mergedEnvVars.filter((envVar) => {
                  if (envVar.isSecret) {
                    return false;
                  }
                  if (envVar.key === "TRIGGER_SECRET_KEY" || envVar.key === "TRIGGER_VERSION") {
                    return false;
                  }
                  return shouldSyncEnvVar(
                    params.syncEnvVarsMapping,
                    envVar.key,
                    mapping.triggerEnvType as TriggerEnvironmentType
                  );
                });

                if (varsToSync.length === 0) {
                  return;
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
                      const existingSecret = await ResultAsync.fromPromise(
                        secretStore.getSecret(SecretValue, varValue.valueReference.key),
                        () => null
                      ).unwrapOr(null);
                      if (existingSecret) {
                        existingValues.set(varValue.variable.key, existingSecret.secret);
                      }
                    }
                  }
                }

                const changedVars = varsToSync.filter((v) => {
                  const existingValue = existingValues.get(v.key);
                  return existingValue === undefined || existingValue !== v.value;
                });

                if (changedVars.length === 0) {
                  return;
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
              })(),
              (error) => error
            );

            if (iterResult.isErr()) {
              const errorMsg = `Failed to process env vars for ${mapping.triggerEnvType}: ${iterResult.error instanceof Error ? iterResult.error.message : "Unknown error"}`;
              errors.push(errorMsg);
              logger.error(errorMsg, {
                projectId: params.projectId,
                vercelProjectId: params.vercelProjectId,
                vercelTarget: mapping.vercelTarget,
                error: iterResult.error,
              });
            }
          }

          return { syncedCount, errors };
        })(),
        (error) => {
          logger.error("Failed to pull env vars from Vercel", {
            projectId: params.projectId,
            vercelProjectId: params.vercelProjectId,
            error,
          });
          return toVercelApiError(error);
        }
      )
    );
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

    const existingEnvsList = extractVercelEnvs(existingEnvs);

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
      const existingEnv = existingEnvsList.find((existing) => {
        if (existing.key !== envVar.key) {
          return false;
        }
        const envTargets = normalizeTarget(existing.target);
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
      const createResult = await ResultAsync.fromPromise(
        client.projects.createProjectEnv({
          idOrName: vercelProjectId,
          ...(teamId && { teamId }),
          requestBody: toCreate.map((item) => ({
            key: item.key,
            value: item.value,
            target: item.target as any,
            type: item.type,
          })) as any,
        }),
        (error) => error
      );

      if (createResult.isOk()) {
        created = toCreate.length;
      } else {
        const errorMsg = `Failed to batch create env vars: ${createResult.error instanceof Error ? createResult.error.message : "Unknown error"}`;
        errors.push(errorMsg);
        logger.error(errorMsg, {
          vercelProjectId,
          teamId,
          count: toCreate.length,
          error: createResult.error,
        });
      }
    }

    // Update existing env vars (Vercel doesn't support batch updates)
    for (const envVar of toUpdate) {
      const updateResult = await ResultAsync.fromPromise(
        client.projects.editProjectEnv({
          idOrName: vercelProjectId,
          id: envVar.id,
          ...(teamId && { teamId }),
          requestBody: {
            value: envVar.value,
            target: envVar.target as any,
            type: envVar.type,
          },
        }),
        (error) => error
      );

      if (updateResult.isOk()) {
        updated++;
      } else {
        const errorMsg = `Failed to update ${envVar.environmentType || envVar.key} env var: ${updateResult.error instanceof Error ? updateResult.error.message : "Unknown error"}`;
        errors.push(errorMsg);
        logger.error(errorMsg, {
          vercelProjectId,
          teamId,
          envVarId: envVar.id,
          key: envVar.key,
          error: updateResult.error,
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

    const envs = extractVercelEnvs(existingEnvs);

    // Vercel can have multiple env vars with the same key but different targets
    const existingEnv = envs.find((existing) => {
      if (existing.key !== key) {
        return false;
      }
      const envTargets = normalizeTarget(existing.target);
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

  static getAutoAssignCustomDomains(
    client: Vercel,
    vercelProjectId: string,
    teamId?: string | null
  ): ResultAsync<boolean | null, VercelApiError> {
    // Vercel SDK lacks a getProject method — updateProject with empty body reads without modifying.
    return wrapVercelCall(
      client.projects.updateProject({
        idOrName: vercelProjectId,
        ...(teamId && { teamId }),
        requestBody: {},
      }),
      "Failed to get Vercel project autoAssignCustomDomains",
      { vercelProjectId, teamId }
    ).map((project) => project.autoAssignCustomDomains ?? null);
  }

  /** Disable autoAssignCustomDomains — required for atomic deployments. */
  static disableAutoAssignCustomDomains(
    client: Vercel,
    vercelProjectId: string,
    teamId?: string | null
  ): ResultAsync<void, VercelApiError> {
    return wrapVercelCall(
      client.projects.updateProject({
        idOrName: vercelProjectId,
        ...(teamId && { teamId }),
        requestBody: {
          autoAssignCustomDomains: false,
        },
      }),
      "Failed to disable autoAssignCustomDomains",
      { vercelProjectId, teamId }
    ).map(() => undefined);
  }

  static uninstallVercelIntegration(
    integration: OrganizationIntegration & { tokenReference: SecretReference }
  ): ResultAsync<{ authInvalid: boolean }, VercelApiError> {
    return this.getVercelClient(integration).andThen((client) =>
      ResultAsync.fromPromise(
        (async () => {
          const secret = await getSecretStore(integration.tokenReference.provider).getSecret(
            VercelSecretSchema,
            integration.tokenReference.key
          );

          if (!secret?.installationId) {
            throw new Error("Installation ID not found in Vercel integration");
          }

          return secret.installationId;
        })(),
        toVercelApiError
      ).andThen((installationId) =>
        ResultAsync.fromPromise(
          client.integrations.deleteConfiguration({
            id: installationId,
          }),
          (error) => error
        )
          .map(() => ({ authInvalid: false }))
          .orElse((error) => {
            const isAuthError = isVercelAuthError(error);
            logger.error("Failed to uninstall Vercel integration", {
              installationId,
              error: error instanceof Error ? error.message : "Unknown error",
              isAuthError,
            });
            // Auth errors (401/403): still clean up on our side, return flag for caller
            if (isAuthError) {
              return okAsync({ authInvalid: true });
            }
            return errAsync(toVercelApiError(error));
          })
      )
    );
  }
}
