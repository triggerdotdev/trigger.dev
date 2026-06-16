import { json } from "@remix-run/server-runtime";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { rbac } from "~/services/rbac.server";

/**
 * Env-tier RBAC for the environment-variable API routes.
 *
 * Machine credentials (an environment's secret/public API key) are already
 * scoped to a single environment, so they pass through unchanged. A personal
 * access token carries a user, so enforce that user's role for the targeted
 * environment tier — e.g. a Developer can't read or write deployed env vars
 * via the API, matching the dashboard restriction.
 *
 * Returns a `Response` to short-circuit with when access is denied, or
 * `undefined` when the request may proceed.
 */
export async function authorizeEnvVarApiRequest({
  request,
  authType,
  organizationId,
  projectId,
  envType,
  action,
}: {
  request: Request;
  authType: "personalAccessToken" | "organizationAccessToken" | "apiKey";
  organizationId: string;
  projectId: string;
  envType: RuntimeEnvironmentType;
  action: "read" | "write";
}): Promise<Response | undefined> {
  if (authType !== "personalAccessToken") {
    return undefined;
  }

  const patAuth = await rbac.authenticatePat(request, { organizationId, projectId });
  if (!patAuth.ok) {
    return json({ error: patAuth.error }, { status: patAuth.status });
  }

  if (!patAuth.ability.can(action, { type: "envvars", envType })) {
    return json(
      { error: "You don't have permission to manage environment variables in this environment." },
      { status: 403 }
    );
  }

  return undefined;
}
