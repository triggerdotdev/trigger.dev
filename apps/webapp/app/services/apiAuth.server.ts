import { json } from "@remix-run/server-runtime";
import { SignJWT } from "jose";
import { z } from "zod";

import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { findProjectByRef } from "~/models/project.server";
import {
  authIncludeBase,
  authIncludeWithParent,
  findEnvironmentByApiKey,
  findEnvironmentByApiKeyWithResolution,
  findEnvironmentByPublicApiKey,
  toAuthenticated,
} from "~/models/runtimeEnvironment.server";
import type {
  BearerAuthOptions,
  RbacAbility,
  RbacResource,
  UserActorClaims,
} from "@trigger.dev/rbac";
import { assertUserActorEnvironment } from "./userActorEnvironment.server";
import { type RuntimeEnvironmentForEnvRepo } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  type PersonalAccessTokenAuthenticationResult,
  authenticateApiRequestWithPersonalAccessToken,
  isPersonalAccessToken,
} from "./personalAccessToken.server";
import {
  type OrganizationAccessTokenAuthenticationResult,
  authenticateApiRequestWithOrganizationAccessToken,
  isOrganizationAccessToken,
} from "./organizationAccessToken.server";
import { isPublicJWT, validatePublicJwtKey } from "./realtime/jwtAuth.server";
import { isDefaultDevBranch, sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
import type { Prisma } from "@trigger.dev/database";
import {
  authenticateAuthorizeBearerWithTelemetry,
  authenticateBearerWithTelemetry,
  observeBranchEnvironmentReplicaMiss,
  observeLegacyBearerAuthentication,
} from "~/services/authTelemetry.server";
import { findWithReplicaRetry } from "~/services/replicaLagRetry.server";
import { isReadReplicaClient } from "@internal/run-store";

const ClaimsSchema = z.object({
  scopes: z.array(z.string()).optional(),
  // One-time use token
  otu: z.boolean().optional(),
  realtime: z
    .object({
      skipColumns: z.array(z.string()).optional(),
    })
    .optional(),
  // Identity only. Authorization comes from `sub` and `scopes`, never from `act`.
  act: z
    .object({
      sub: z.string(),
      client: z.string().optional(),
    })
    .optional(),
});

// Re-export the slim shape defined in @trigger.dev/core. Single source of
// truth across the auth boundary (RBAC plugin contract → webapp handlers).
export type { AuthenticatedEnvironment } from "@trigger.dev/core/v3/auth/environment";
import type { AuthenticatedEnvironment } from "@trigger.dev/core/v3/auth/environment";

export type ApiAuthenticationResult =
  | ApiAuthenticationResultSuccess
  | ApiAuthenticationResultFailure;

export type ApiAuthenticationResultSuccess = {
  ok: true;
  apiKey: string;
  type: "PUBLIC" | "PRIVATE" | "PUBLIC_JWT";
  environment: AuthenticatedEnvironment;
  oneTimeUse?: boolean;
  realtime?: {
    skipColumns?: string[];
  };
  // Present when authentication went through the RBAC bearer controller.
  // Legacy direct authentication intentionally omits it and remains fail-closed
  // for restricted additional keys.
  ability?: RbacAbility;
  // Present when the request used a public JWT minted from a PAT/UAT exchange
  // that stamped an `act` delegation claim. `actor.sub` is the acting user id,
  // used for attribution (e.g. who resolved an error). Absent for plain env
  // API keys (no user) and JWTs minted without delegation.
  actor?: {
    sub: string;
    client?: string;
  };
};

type ApiAuthenticationResultFailure = {
  ok: false;
  error: string;
};

/**
 * @deprecated Use `authenticateApiRequestWithFailure` instead.
 */
export async function authenticateApiRequest(
  request: Request,
  options: { allowPublicKey?: boolean; allowJWT?: boolean } = {}
): Promise<ApiAuthenticationResultSuccess | undefined> {
  const { apiKey, branchName } = getApiKeyFromRequest(request);

  if (!apiKey) {
    return;
  }

  return observeLegacyBearerAuthentication(request, () =>
    authenticateApiKey(apiKey, { ...options, branchName })
  );
}

/**
 * This method is the same as `authenticateApiRequest` but it returns a failure result instead of undefined.
 * It should be used from now on to ensure that the API key is always validated and provide a failure result.
 */
export async function authenticateApiRequestWithFailure(
  request: Request,
  options: { allowPublicKey?: boolean; allowJWT?: boolean } = {}
): Promise<ApiAuthenticationResult> {
  const { apiKey, branchName } = getApiKeyFromRequest(request);

  if (!apiKey) {
    return {
      ok: false,
      error: "Invalid API Key",
    };
  }

  return observeLegacyBearerAuthentication(request, () =>
    authenticateApiKeyWithFailure(apiKey, { ...options, branchName })
  );
}

/**
 * @deprecated Use `authenticateApiKeyWithFailure` instead.
 */
export async function authenticateApiKey(
  apiKey: string,
  options: {
    allowPublicKey?: boolean;
    allowJWT?: boolean;
    branchName?: string;
  } = {}
): Promise<ApiAuthenticationResultSuccess | undefined> {
  const result = getApiKeyResult(apiKey);

  if (!result) {
    return;
  }

  if (!options.allowPublicKey && result.type === "PUBLIC") {
    return;
  }

  if (!options.allowJWT && result.type === "PUBLIC_JWT") {
    return;
  }

  switch (result.type) {
    case "PUBLIC": {
      const environment = await findEnvironmentByPublicApiKey(result.apiKey, options.branchName);
      if (!environment) {
        return;
      }

      return {
        ok: true,
        ...result,
        environment,
      };
    }
    case "PRIVATE": {
      const environment = await findEnvironmentByApiKey(result.apiKey, options.branchName);
      if (!environment) {
        return;
      }

      return {
        ok: true,
        ...result,
        environment,
      };
    }
    case "PUBLIC_JWT": {
      const validationResults = await validatePublicJwtKey(result.apiKey);

      if (!validationResults.ok) {
        return;
      }

      const parsedClaims = ClaimsSchema.safeParse(validationResults.claims);

      return {
        ok: true,
        ...result,
        environment: validationResults.environment,
        oneTimeUse: parsedClaims.success ? parsedClaims.data.otu : false,
        realtime: parsedClaims.success ? parsedClaims.data.realtime : undefined,
        actor: parsedClaims.success ? parsedClaims.data.act : undefined,
      };
    }
  }
}

/**
 * This method is the same as `authenticateApiKey` but it returns a failure result instead of undefined.
 * It should be used from now on to ensure that the API key is always validated and provide a failure result.
 */
async function authenticateApiKeyWithFailure(
  apiKey: string,
  options: {
    allowPublicKey?: boolean;
    allowJWT?: boolean;
    branchName?: string;
  } = {}
): Promise<ApiAuthenticationResult> {
  const result = getApiKeyResult(apiKey);

  if (!result) {
    return {
      ok: false,
      error: "Invalid API Key",
    };
  }

  if (!options.allowPublicKey && result.type === "PUBLIC") {
    return {
      ok: false,
      error: "Public API keys are not allowed for this request",
    };
  }

  if (!options.allowJWT && result.type === "PUBLIC_JWT") {
    return {
      ok: false,
      error: "Public JWT API keys are not allowed for this request",
    };
  }

  switch (result.type) {
    case "PUBLIC": {
      const environment = await findEnvironmentByPublicApiKey(result.apiKey, options.branchName);
      if (!environment) {
        return {
          ok: false,
          error: "Invalid API Key",
        };
      }

      return {
        ok: true,
        ...result,
        environment,
      };
    }
    case "PRIVATE": {
      const resolution = await findEnvironmentByApiKeyWithResolution(
        result.apiKey,
        options.branchName
      );
      if (!resolution.ok) {
        return {
          ok: false,
          error:
            resolution.reason === "restricted"
              ? "This endpoint does not support restricted API keys. Use an API key with full environment access."
              : "Invalid API Key",
        };
      }

      return {
        ok: true,
        ...result,
        environment: resolution.environment,
      };
    }
    case "PUBLIC_JWT": {
      const validationResults = await validatePublicJwtKey(result.apiKey);

      if (!validationResults.ok) {
        return validationResults;
      }

      const parsedClaims = ClaimsSchema.safeParse(validationResults.claims);

      return {
        ok: true,
        ...result,
        environment: validationResults.environment,
        oneTimeUse: parsedClaims.success ? parsedClaims.data.otu : false,
        realtime: parsedClaims.success ? parsedClaims.data.realtime : undefined,
        actor: parsedClaims.success ? parsedClaims.data.act : undefined,
      };
    }
  }
}

/** Authenticate a private API-key request without requiring a resource scope. */
export async function authenticateApiKeyRequest(
  request: Request,
  options: BearerAuthOptions = {},
  authenticateBearer: typeof authenticateBearerWithTelemetry = authenticateBearerWithTelemetry
): Promise<
  | { ok: true; authentication: ApiAuthenticationResultSuccess }
  | { ok: false; status: 401 | 403; error: string }
> {
  const apiKey = getApiKeyFromHeader(request.headers.get("Authorization"));
  if (!apiKey) {
    return { ok: false, status: 401, error: "Invalid or Missing API key" };
  }

  const result = await authenticateBearer(request, options);
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    authentication: {
      ok: true,
      apiKey,
      type: "PRIVATE",
      environment: result.environment,
      ability: result.ability,
    },
  };
}

/**
 * Authenticate an API-key request for a legacy (non-apiBuilder) route that
 * needs to accept granular additional keys, then enforce that the key's ability
 * authorizes `action` on `resource`. Root keys (and grace-window root keys)
 * carry the unrestricted `admin` ability, preserving pre-granular behavior.
 *
 * Only apiKey credentials are accepted (no PAT / org token / public key). Use
 * this for routes previously guarded by a bare `authenticateApiRequest` call.
 */
export type ApiKeyScopeAuthorization = {
  action: string;
  resource: RbacResource;
  allowJWT?: boolean;
  allowPreviewParent?: boolean;
};

export async function authenticateApiKeyWithScope(
  request: Request,
  { action, resource, allowJWT = false, allowPreviewParent = false }: ApiKeyScopeAuthorization,
  authorizeBearer: typeof authenticateAuthorizeBearerWithTelemetry = authenticateAuthorizeBearerWithTelemetry
): Promise<
  | { ok: true; authentication: ApiAuthenticationResultSuccess }
  | { ok: false; status: 401 | 403; error: string }
> {
  const apiKey = getApiKeyFromHeader(request.headers.get("Authorization"));
  if (!apiKey) {
    return { ok: false, status: 401, error: "Invalid or Missing API key" };
  }

  const result = await authorizeBearer(
    request,
    { action, resource },
    { allowJWT, allowPreviewParent }
  );
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    authentication: {
      ok: true,
      apiKey,
      type: "PRIVATE",
      environment: result.environment,
      ability: result.ability,
    },
  };
}

export type ScopedApiKeyAuthenticationDependencies = {
  authenticateRequest: typeof authenticateRequest;
  authenticateApiKeyWithScope: typeof authenticateApiKeyWithScope;
};

export async function authenticateRequestWithScopedApiKey(
  request: Request,
  {
    personalAccessToken,
    organizationAccessToken,
    apiKey,
  }: {
    personalAccessToken: true;
    organizationAccessToken: true;
    apiKey: ApiKeyScopeAuthorization;
  },
  dependencies: ScopedApiKeyAuthenticationDependencies = {
    authenticateRequest,
    authenticateApiKeyWithScope,
  }
): Promise<
  | { ok: true; authentication: AuthenticationResult }
  | { ok: false; status: 401 | 403; error: string }
> {
  const userOrOrganizationAuthentication = await dependencies.authenticateRequest(request, {
    personalAccessToken,
    organizationAccessToken,
    apiKey: false,
  });
  if (userOrOrganizationAuthentication) {
    return { ok: true, authentication: userOrOrganizationAuthentication };
  }

  const apiKeyAuthentication = await dependencies.authenticateApiKeyWithScope(request, apiKey);
  if (!apiKeyAuthentication.ok) {
    return apiKeyAuthentication;
  }

  return {
    ok: true,
    authentication: { type: "apiKey", result: apiKeyAuthentication.authentication },
  };
}

export async function authenticateAuthorizationHeader(
  authorization: string,
  {
    allowPublicKey = false,
    allowJWT = false,
  }: { allowPublicKey?: boolean; allowJWT?: boolean } = {}
): Promise<ApiAuthenticationResult | undefined> {
  const apiKey = getApiKeyFromHeader(authorization);

  if (!apiKey) {
    return;
  }

  return authenticateApiKey(apiKey, { allowPublicKey, allowJWT });
}

function isPublicApiKey(key: string) {
  return key.startsWith("pk_");
}

function isSecretApiKey(key: string) {
  return key.startsWith("tr_");
}

/**
 * Reads the branch off the `x-trigger-branch` header and sanitizes it.
 * Every server-side reader should go through here so sanitization is applied uniformly.
 * The dev `"default"` sentinel is intentionally NOT resolved here:
 * that translation is environment type-dependent.
 */
export function branchNameFromRequest(request: Request): string | undefined {
  return sanitizeBranchName(request.headers.get("x-trigger-branch")) ?? undefined;
}

function getApiKeyFromRequest(request: Request): {
  apiKey: string | undefined;
  branchName: string | undefined;
} {
  const apiKey = getApiKeyFromHeader(request.headers.get("Authorization"));
  const branchName = branchNameFromRequest(request);

  return { apiKey, branchName };
}

function getApiKeyFromHeader(authorization?: string | null) {
  if (typeof authorization !== "string" || !authorization) {
    return;
  }

  const apiKey = authorization.replace(/^Bearer /, "");
  return apiKey;
}

function getApiKeyResult(apiKey: string): {
  apiKey: string;
  type: "PUBLIC" | "PRIVATE" | "PUBLIC_JWT";
} {
  const type = isPublicApiKey(apiKey)
    ? "PUBLIC"
    : isSecretApiKey(apiKey)
      ? "PRIVATE"
      : isPublicJWT(apiKey)
        ? "PUBLIC_JWT"
        : "PRIVATE"; // Fallback to private key
  return { apiKey, type };
}

/**
 * The authenticated user-actor. A user-actor token authenticates as its user, so it is the same
 * shape a PAT authenticates to — that shape now carries the token's verified claims itself, so
 * any layer holding the actor holds its environment scope.
 */
export type UserActorAuthenticatedActor = PersonalAccessTokenAuthenticationResult;

export type AuthenticationResult =
  | {
      type: "personalAccessToken";
      result: UserActorAuthenticatedActor;
      /**
       * Claims of the delegated user-actor token the caller presented, if any. A UAT authenticates
       * as its user, so it rides on this variant; its environment scope is enforced on resolution.
       */
      userActor?: UserActorClaims;
    }
  | {
      type: "organizationAccessToken";
      result: OrganizationAccessTokenAuthenticationResult;
    }
  | {
      type: "apiKey";
      result: ApiAuthenticationResult;
    };

type AuthenticationMethod = "personalAccessToken" | "organizationAccessToken" | "apiKey";

type AllowedAuthenticationMethods = Record<AuthenticationMethod, boolean> &
  ({ personalAccessToken: true } | { organizationAccessToken: true } | { apiKey: true });

const defaultAllowedAuthenticationMethods: AllowedAuthenticationMethods = {
  personalAccessToken: true,
  organizationAccessToken: true,
  apiKey: true,
};

type FilteredAuthenticationResult<
  T extends AllowedAuthenticationMethods = AllowedAuthenticationMethods,
> =
  | (T["personalAccessToken"] extends true
      ? Extract<AuthenticationResult, { type: "personalAccessToken" }>
      : never)
  | (T["organizationAccessToken"] extends true
      ? Extract<AuthenticationResult, { type: "organizationAccessToken" }>
      : never)
  | (T["apiKey"] extends true ? Extract<AuthenticationResult, { type: "apiKey" }> : never);

/**
 * Authenticates an incoming request by checking for various token types.
 *
 * Supports personal access tokens, organization access tokens, and API keys.
 * Returns the appropriate authentication result based on the token type found.
 *
 * This method currently only allows private keys for the `apiKey` authentication method.
 *
 * @template T - The allowed authentication methods configuration type
 * @param request - The incoming HTTP request containing authentication headers
 * @param allowedAuthenticationMethods - Configuration object specifying which authentication methods are allowed.
 *   At least one method must be set to `true`. Defaults to allowing all methods.
 * @returns Authentication result with only the enabled auth method types, or undefined if no valid token found
 *
 * @example
 * ```typescript
 * // Only allow personal access tokens
 * const result = await authenticateRequest(request, {
 *   personalAccessToken: true,
 *   organizationAccessToken: false,
 *   apiKey: false,
 * });
 * // result type: { type: "personalAccessToken"; result: PersonalAccessTokenAuthenticationResult } | undefined
 * ```
 */
export async function authenticateRequest<
  T extends AllowedAuthenticationMethods = AllowedAuthenticationMethods,
>(
  request: Request,
  allowedAuthenticationMethods?: T
): Promise<FilteredAuthenticationResult<T> | undefined> {
  const allowedMethods = allowedAuthenticationMethods ?? defaultAllowedAuthenticationMethods;

  const { apiKey, branchName } = getApiKeyFromRequest(request);
  if (!apiKey) {
    return;
  }

  if (allowedMethods.personalAccessToken && isPersonalAccessToken(apiKey)) {
    const result = await authenticateApiRequestWithPersonalAccessToken(request);

    if (!result) {
      return;
    }

    return {
      type: "personalAccessToken",
      result,
    } satisfies Extract<
      AuthenticationResult,
      { type: "personalAccessToken" }
    > as FilteredAuthenticationResult<T>;
  }

  if (allowedMethods.organizationAccessToken && isOrganizationAccessToken(apiKey)) {
    const result = await authenticateApiRequestWithOrganizationAccessToken(request);

    if (!result) {
      return;
    }

    return {
      type: "organizationAccessToken",
      result,
    } satisfies Extract<
      AuthenticationResult,
      { type: "organizationAccessToken" }
    > as FilteredAuthenticationResult<T>;
  }

  if (allowedMethods.apiKey) {
    const result = await authenticateApiKey(apiKey, {
      allowPublicKey: false,
      branchName,
    });

    if (!result) {
      return;
    }

    return {
      type: "apiKey",
      result,
    } satisfies Extract<
      AuthenticationResult,
      { type: "apiKey" }
    > as FilteredAuthenticationResult<T>;
  }

  return;
}

/**
 * Resolve the environment a request targets, and enforce the caller's environment scope.
 *
 * Every route that turns an authentication result into an environment goes through here, so the
 * user-actor token's `environmentId` claim is checked once, at the seam — a new endpoint can't
 * forget it.
 */
export async function authenticatedEnvironmentForAuthentication(
  auth: AuthenticationResult,
  projectRef: string,
  slug: string,
  branch?: string
): Promise<AuthenticatedEnvironment> {
  const environment = await resolveEnvironmentForAuthentication(auth, projectRef, slug, branch);

  if (auth.type === "personalAccessToken") {
    // Either place the claims ride: on the actor (the shape every layer keeps) or beside it.
    assertUserActorEnvironment(auth.result.userActor ?? auth.userActor, environment.id);
  }

  return environment;
}

const BRANCH_ENV_REPLICA_RETRY_DELAY_MS = { min: 50, max: 200 };

// A just-created branch env can be missing from the replica when its first deploy authenticates.
function findBranchEnvironment(where: Prisma.RuntimeEnvironmentWhereInput) {
  return findWithReplicaRetry({
    replicaFind: () =>
      $replica.runtimeEnvironment.findFirst({ where, include: authIncludeWithParent }),
    primaryFind: () =>
      prisma.runtimeEnvironment.findFirst({ where, include: authIncludeWithParent }),
    hasDedicatedReplica: isReadReplicaClient($replica),
    retryDelayMs: BRANCH_ENV_REPLICA_RETRY_DELAY_MS,
    onOutcome: observeBranchEnvironmentReplicaMiss,
  });
}

async function resolveEnvironmentForAuthentication(
  auth: AuthenticationResult,
  projectRef: string,
  slug: string,
  branch?: string
): Promise<AuthenticatedEnvironment> {
  if (slug === "staging") {
    slug = "stg";
  }

  // Normalize the requested branch once: sanitize it, then collapse the dev
  // `"default"` sentinel to "no branch" so it resolves to the root dev env
  // rather than a (non-existent) branch literally named "default".
  // TODO this slug check is brittle
  const sanitizedBranch = sanitizeBranchName(branch);
  const resolvedBranch =
    slug === "dev" && isDefaultDevBranch(sanitizedBranch) ? null : sanitizedBranch;

  switch (auth.type) {
    case "apiKey": {
      if (!auth.result.ok) {
        throw json({ error: auth.result.error }, { status: 401 });
      }

      if (auth.result.environment.project.externalRef !== projectRef) {
        throw json(
          {
            error:
              "Invalid project ref for this API key. Make sure you are using an API key associated with that project.",
          },
          { status: 400 }
        );
      }

      if (
        auth.result.environment.slug !== slug &&
        auth.result.environment.branchName !== resolvedBranch
      ) {
        throw json(
          {
            error:
              "Invalid environment slug for this API key. Make sure you are using an API key associated with that environment.",
          },
          { status: 400 }
        );
      }

      return auth.result.environment;
    }
    case "personalAccessToken": {
      const user = await $replica.user.findUnique({
        where: {
          id: auth.result.userId,
        },
      });

      if (!user) {
        throw json({ error: "Invalid or missing personal access token" }, { status: 401 });
      }

      const project = await findProjectByRef(projectRef, user.id);

      if (!project) {
        throw json({ error: "Project not found" }, { status: 404 });
      }

      if (!resolvedBranch) {
        const environment = await $replica.runtimeEnvironment.findFirst({
          where: {
            projectId: project.id,
            slug: slug,
            ...(slug === "dev"
              ? {
                  orgMember: {
                    userId: user.id,
                  },
                }
              : {}),
          },
          include: authIncludeBase,
        });

        if (!environment) {
          throw json({ error: "Environment not found" }, { status: 404 });
        }

        return toAuthenticated(environment);
      }

      const environment = await findBranchEnvironment({
        projectId: project.id,
        type: slug === "dev" ? "DEVELOPMENT" : "PREVIEW",
        branchName: resolvedBranch,
        ...(slug === "dev"
          ? {
              orgMember: {
                userId: user.id,
              },
            }
          : {}),
        archivedAt: null,
      });

      if (!environment) {
        throw json({ error: "Branch not found" }, { status: 404 });
      }

      if (!environment.parentEnvironment) {
        throw json({ error: "Branch not associated with a parent environment" }, { status: 400 });
      }

      // PREVIEW envs (and DEVELOPMENT branches) reuse the parent's apiKey for downstream auth flows
      // (signed JWTs, internal-fetch helpers). Override before mapping so
      // the slim shape carries the parent's key.
      return toAuthenticated({
        ...environment,
        apiKey: environment.parentEnvironment.apiKey,
      });
    }
    case "organizationAccessToken": {
      const organization = await $replica.organization.findUnique({
        where: {
          id: auth.result.organizationId,
        },
      });

      if (!organization) {
        throw json({ error: "Invalid or missing organization access token" }, { status: 401 });
      }

      const project = await $replica.project.findFirst({
        where: {
          organizationId: organization.id,
          externalRef: projectRef,
        },
      });

      if (!project) {
        throw json({ error: "Project not found" }, { status: 404 });
      }

      if (!resolvedBranch) {
        const environment = await $replica.runtimeEnvironment.findFirst({
          where: {
            projectId: project.id,
            slug: slug,
          },
          include: authIncludeBase,
        });

        if (!environment) {
          throw json({ error: "Environment not found" }, { status: 404 });
        }

        return toAuthenticated(environment);
      }

      const environment = await findBranchEnvironment({
        projectId: project.id,
        // No Development branches for OAT
        type: "PREVIEW",
        branchName: resolvedBranch,
        archivedAt: null,
      });

      if (!environment) {
        throw json({ error: "Branch not found" }, { status: 404 });
      }

      if (!environment.parentEnvironment) {
        throw json({ error: "Branch not associated with a preview environment" }, { status: 400 });
      }

      return toAuthenticated({
        ...environment,
        apiKey: environment.parentEnvironment.apiKey,
      });
    }
    default: {
      auth satisfies never;
      throw json({ error: "Invalid authentication result" }, { status: 401 });
    }
  }
}

const JWT_SECRET = new TextEncoder().encode(env.SESSION_SECRET);
const JWT_ALGORITHM = "HS256";
const DEFAULT_JWT_EXPIRATION_IN_MS = 1000 * 60 * 60; // 1 hour

export async function generateJWTTokenForEnvironment(
  environment: RuntimeEnvironmentForEnvRepo,
  payload: Record<string, string>
) {
  const jwt = await new SignJWT({
    environment_id: environment.id,
    org_id: environment.organizationId,
    project_id: environment.projectId,
    ...payload,
  })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuedAt()
    .setIssuer("https://id.trigger.dev")
    .setAudience("https://api.trigger.dev")
    .setExpirationTime(calculateJWTExpiration())
    .sign(JWT_SECRET);

  return jwt;
}

function calculateJWTExpiration() {
  if (env.PROD_USAGE_HEARTBEAT_INTERVAL_MS) {
    return (
      (Date.now() + Math.max(DEFAULT_JWT_EXPIRATION_IN_MS, env.PROD_USAGE_HEARTBEAT_INTERVAL_MS)) /
      1000
    );
  }

  return (Date.now() + DEFAULT_JWT_EXPIRATION_IN_MS) / 1000;
}

export async function getOneTimeUseToken(
  auth: ApiAuthenticationResultSuccess
): Promise<string | undefined> {
  if (auth.type !== "PUBLIC_JWT") {
    return;
  }

  if (!auth.oneTimeUse) {
    return;
  }

  // Hash the API key to make it unique
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth.apiKey));

  return Buffer.from(hash).toString("hex");
}
