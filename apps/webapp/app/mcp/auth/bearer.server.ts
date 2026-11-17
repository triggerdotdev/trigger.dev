import { isUserActorToken, type HostRbacController, type UserActorClaims } from "@trigger.dev/rbac";
import type { McpIdentity } from "../types";

type PatAuthFailure = Extract<
  Awaited<ReturnType<HostRbacController["authenticatePat"]>>,
  { ok: false }
>;

export type McpBearerAuthResult =
  | { ok: true; identity: McpIdentity }
  | { ok: false; response: Response };

export type McpBearerAuthDeps = {
  rbac: Pick<HostRbacController, "authenticatePat" | "authenticateUserActor">;
  failureBody: (failure: PatAuthFailure) => unknown;
  recheckUserActorClaims: (
    claims: UserActorClaims | undefined,
    bearer: string,
    audience: string
  ) => Promise<UserActorClaims | undefined>;
  touchPat: (tokenId: string, lastAccessedAt: Date | null | undefined) => Promise<unknown>;
  resourceMetadataUrl: string;
  /** User-actor tokens must be minted for this audience, the MCP resource. */
  audience: string;
};

export function createMcpBearerAuthenticator(deps: McpBearerAuthDeps) {
  const unauthorized = (body: unknown, status: number = 401): McpBearerAuthResult => ({
    ok: false,
    response: Response.json(body, {
      status,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${deps.resourceMetadataUrl}"`,
      },
    }),
  });

  return async function authenticateMcpBearer(request: Request): Promise<McpBearerAuthResult> {
    const bearer = request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim();
    if (!bearer) {
      return unauthorized({ error: "Missing bearer token" });
    }

    if (isUserActorToken(bearer)) {
      const { audience } = deps;
      const uatAuth = await deps.rbac.authenticateUserActor(request, {}, { audience });
      if (!uatAuth.ok) {
        return unauthorized({ error: uatAuth.error }, uatAuth.status);
      }
      const claims = await deps.recheckUserActorClaims(uatAuth.claims, bearer, audience);
      if (!claims?.pat) {
        return unauthorized({ error: "Invalid user-actor token" });
      }
      await deps.touchPat(claims.pat, undefined);
      return {
        ok: true,
        identity: {
          kind: "uat",
          userId: uatAuth.userId,
          sourceTokenId: claims.pat,
          clientId: claims.client,
          cap: claims.cap,
          organizationId: claims.organizationId,
          environmentId: claims.environmentId,
        },
      };
    }

    const patAuth = await deps.rbac.authenticatePat(request, {});
    if (!patAuth.ok) {
      return unauthorized(deps.failureBody(patAuth), patAuth.status);
    }
    await deps.touchPat(patAuth.tokenId, patAuth.lastAccessedAt);
    return {
      ok: true,
      identity: { kind: "pat", userId: patAuth.userId, tokenId: patAuth.tokenId },
    };
  };
}
