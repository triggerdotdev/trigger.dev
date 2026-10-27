import { trace } from "@opentelemetry/api";
import type { AuthenticatedEnvironment } from "@trigger.dev/core/v3/auth/environment";
import { buildJwtAbility, withActionAliases, type RbacAbility } from "@trigger.dev/rbac";
import { env } from "~/env.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { internalRunSigningService } from "./instance.server";
import { verifyRunToken, type RunTokenClaims } from "./runTokenVerify";

export type RunTokenAuthResult =
  | { ok: false; status: 401; error: string }
  | {
      ok: true;
      environment: AuthenticatedEnvironment;
      ability: RbacAbility;
      claims: RunTokenClaims;
    };

async function verifyRunTokenWithActiveKeys(token: string): Promise<RunTokenClaims | undefined> {
  if (!env.RUN_TOKEN_ISSUER_URL) return undefined;

  // Internal keys only, loaded from storage through the service cache. Never the external JWKS.
  return verifyRunToken({
    token,
    jwks: await internalRunSigningService.getPublicJwks(),
    issuer: env.RUN_TOKEN_ISSUER_URL,
  });
}

/**
 * Verifies a run token locally against the cached internal keys, then loads its environment with
 * one lookup. Rejects archived environments and any org or project mismatch. Does not check that
 * the run is still executing. Tokens have an independent 24-hour lifetime: root-key rotation
 * does not revoke them. There is no per-token emergency revocation.
 */
export async function resolveRunToken(
  token: string
): Promise<{ claims: RunTokenClaims; environment: AuthenticatedEnvironment } | undefined> {
  const claims = await verifyRunTokenWithActiveKeys(token);
  if (!claims) return undefined;

  const environment = await findEnvironmentById(claims.environment_id);
  if (
    !environment ||
    environment.archivedAt !== null ||
    environment.organizationId !== claims.org_id ||
    environment.projectId !== claims.project_id
  ) {
    return undefined;
  }

  return { claims, environment };
}

export async function authenticateRunToken(token: string): Promise<RunTokenAuthResult> {
  const resolved = await resolveRunToken(token);
  if (!resolved) {
    return { ok: false, status: 401, error: "Invalid run token" };
  }
  const { claims, environment } = resolved;

  trace.getActiveSpan()?.setAttributes({
    "auth.run_token.run_id": claims.run_id,
    "auth.run_token.attempt": claims.attempt,
  });

  return {
    ok: true,
    environment,
    ability: withActionAliases(buildJwtAbility(claims.scopes)),
    claims,
  };
}
