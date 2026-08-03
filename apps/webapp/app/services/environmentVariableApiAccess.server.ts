import { json } from "@remix-run/server-runtime";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { isUserActorToken } from "@trigger.dev/rbac";
import type { RbacAbility } from "@trigger.dev/rbac";
import {
  authenticateApiKeyWithScope,
  authenticateRequest,
  type AuthenticationResult,
} from "~/services/apiAuth.server";
import { rbac } from "~/services/rbac.server";

type EnvironmentScopedResource = "envvars" | "apiKeys";

type EnvironmentScopedAuthentication =
  | { ok: true; authentication: AuthenticationResult }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Returns the credential already presented by an authenticated API-key caller.
 * API-key exchanges must reuse this value instead of exposing the environment's
 * root credential.
 */
export function presentedApiKeyFromAuthentication(
  authentication: AuthenticationResult
): string | undefined {
  return authentication.type === "apiKey" && authentication.result.ok
    ? authentication.result.apiKey
    : undefined;
}

/**
 * Keep PAT/OAT authentication on the legacy path while routing machine API
 * keys through the RBAC controller, where plugin grants are applied.
 */
export async function authenticateEnvironmentScopedApiRequest(
  request: Request,
  action: "read" | "write",
  resource: EnvironmentScopedResource
): Promise<EnvironmentScopedAuthentication> {
  const userOrOrganizationAuthentication = await authenticateRequest(request, {
    personalAccessToken: true,
    organizationAccessToken: true,
    apiKey: false,
  });
  if (userOrOrganizationAuthentication) {
    return { ok: true, authentication: userOrOrganizationAuthentication };
  }

  const apiKeyAuthentication = await authenticateApiKeyWithScope(request, {
    action,
    resource: { type: resource },
  });
  if (!apiKeyAuthentication.ok) {
    return apiKeyAuthentication;
  }

  return {
    ok: true,
    authentication: { type: "apiKey", result: apiKeyAuthentication.authentication },
  };
}

/** Env var API routes: PAT/OAT on the legacy path, machine keys via RBAC. */
export function authenticateEnvVarApiRequest(
  request: Request,
  action: "read" | "write"
): Promise<EnvironmentScopedAuthentication> {
  return authenticateEnvironmentScopedApiRequest(request, action, "envvars");
}

const RESOURCE_LABELS: Record<EnvironmentScopedResource, string> = {
  envvars: "environment variables",
  apiKeys: "API keys",
};

/**
 * Env-tier RBAC for environment-scoped API routes (env vars, and the endpoints
 * that hand out an environment's secret credentials).
 *
 * Machine credentials (an environment's API key) are authorized by the
 * ability returned by the RBAC bearer controller. A personal
 * access token (or a delegated user-actor token) carries a user, so enforce
 * that user's role for the targeted environment tier — e.g. a Developer can't
 * read deployed env vars or API keys via the API, matching the dashboard
 * restriction. Blocking the credential read for deployed tiers is also what
 * stops a restricted role deploying via the CLI (deploy needs the
 * environment's secret key).
 *
 * Returns a `Response` to short-circuit with when access is denied, or
 * `undefined` when the request may proceed.
 */
export async function authorizePatEnvironmentAccess({
  request,
  authType,
  organizationId,
  projectId,
  envType,
  resource,
  action,
  ability,
}: {
  request: Request;
  authType: "personalAccessToken" | "organizationAccessToken" | "apiKey";
  organizationId: string;
  projectId: string;
  envType: RuntimeEnvironmentType;
  resource: EnvironmentScopedResource;
  action: "read" | "write";
  // Controller ability for API-key credentials. Absent for PAT/OAT callers.
  ability?: RbacAbility;
}): Promise<Response | undefined> {
  const bearer = request.headers
    .get("Authorization")
    ?.replace(/^Bearer /, "")
    .trim();
  const isUat = !!bearer && isUserActorToken(bearer);

  // Machine API keys are authorized by their controller ability. Root keys and
  // ungranted additional keys are permissive; granted keys are restricted.
  if (authType === "apiKey") {
    if (ability?.can(action, { type: resource })) {
      return undefined;
    }
    return json(
      {
        error: `You don't have permission to access this environment's ${RESOURCE_LABELS[resource]}.`,
      },
      { status: 403 }
    );
  }

  // Org tokens carry no user role to enforce. A user-actor token carries a
  // user just like a PAT, so it's gated too.
  if (authType !== "personalAccessToken" && !isUat) {
    return undefined;
  }

  const userAuth = isUat
    ? await rbac.authenticateUserActor(request, { organizationId, projectId })
    : await rbac.authenticatePat(request, { organizationId, projectId });
  if (!userAuth.ok) {
    return json({ error: userAuth.error }, { status: userAuth.status });
  }

  if (!userAuth.ability.can(action, { type: resource, envType })) {
    return json(
      {
        error: `You don't have permission to access this environment's ${RESOURCE_LABELS[resource]}.`,
      },
      { status: 403 }
    );
  }

  return undefined;
}

/** Env-tier env var access for the env var API routes. */
export function authorizeEnvVarApiRequest(opts: {
  request: Request;
  authType: "personalAccessToken" | "organizationAccessToken" | "apiKey";
  organizationId: string;
  projectId: string;
  envType: RuntimeEnvironmentType;
  action: "read" | "write";
  ability?: RbacAbility;
}): Promise<Response | undefined> {
  return authorizePatEnvironmentAccess({ ...opts, resource: "envvars" });
}
