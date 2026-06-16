import { json } from "@remix-run/server-runtime";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { rbac } from "~/services/rbac.server";

type EnvironmentScopedResource = "envvars" | "apiKeys";

const RESOURCE_LABELS: Record<EnvironmentScopedResource, string> = {
  envvars: "environment variables",
  apiKeys: "API keys",
};

/**
 * Env-tier RBAC for environment-scoped API routes (env vars, and the endpoints
 * that hand out an environment's secret credentials).
 *
 * Machine credentials (an environment's secret/public API key) are already
 * scoped to a single environment, so they pass through unchanged. A personal
 * access token carries a user, so enforce that user's role for the targeted
 * environment tier — e.g. a Developer can't read deployed env vars or API keys
 * via the API, matching the dashboard restriction. Blocking the credential read
 * for deployed tiers is also what stops a restricted role deploying via the CLI
 * (deploy needs the environment's secret key).
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
}: {
  request: Request;
  authType: "personalAccessToken" | "organizationAccessToken" | "apiKey";
  organizationId: string;
  projectId: string;
  envType: RuntimeEnvironmentType;
  resource: EnvironmentScopedResource;
  action: "read" | "write";
}): Promise<Response | undefined> {
  if (authType !== "personalAccessToken") {
    return undefined;
  }

  const patAuth = await rbac.authenticatePat(request, { organizationId, projectId });
  if (!patAuth.ok) {
    return json({ error: patAuth.error }, { status: patAuth.status });
  }

  if (!patAuth.ability.can(action, { type: resource, envType })) {
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
}): Promise<Response | undefined> {
  return authorizePatEnvironmentAccess({ ...opts, resource: "envvars" });
}
