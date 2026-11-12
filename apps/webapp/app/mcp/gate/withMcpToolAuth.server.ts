import { buildJwtAbility, CAPLESS_USER_ACTOR_SCOPES, type RbacAbility } from "@trigger.dev/rbac";
import { logger } from "~/services/logger.server";
import { resolveAndRecheckUserActorClaims } from "~/services/personalAccessToken.server";
import { rbac } from "~/services/rbac.server";
import { resolveMcpSubject } from "./resolveSubject.server";
import type { McpIdentity, McpSubject, McpToolAuth } from "./types";

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type McpToolContext = {
  identity: McpIdentity;
  subject: McpSubject | null;
  request: Request;
};

type Outcome = "ok" | "denied" | "error";

const denied = (): McpToolResult => ({
  content: [{ type: "text", text: "Not authorized" }],
  isError: true,
});

const failed = (): McpToolResult => ({
  content: [{ type: "text", text: "The tool failed. Try again later." }],
  isError: true,
});

async function authenticate(
  identity: McpIdentity,
  request: Request,
  context: { organizationId?: string; projectId?: string }
): Promise<RbacAbility | null> {
  if (identity.kind === "pat") {
    const result = await rbac.authenticatePat(request, context);
    if (!result.ok) return null;
    const same = result.userId === identity.userId && result.tokenId === identity.tokenId;
    return same ? result.ability : null;
  }

  const result = await rbac.authenticateUserActor(request, context);
  if (!result.ok) return null;
  const bearer = request.headers
    .get("Authorization")
    ?.replace(/^Bearer /, "")
    .trim();
  const claims = bearer && (await resolveAndRecheckUserActorClaims(result.claims, bearer));
  if (!claims) return null;
  const same =
    result.userId === identity.userId &&
    claims.userId === identity.userId &&
    claims.pat === identity.sourceTokenId &&
    claims.organizationId === identity.organizationId &&
    claims.environmentId === identity.environmentId;
  return same ? result.ability : null;
}

function outsideTokenScope(identity: McpIdentity, subject: McpSubject): boolean {
  if (identity.kind !== "uat") return false;
  if (identity.organizationId && identity.organizationId !== subject.organizationId) return true;
  return !!identity.environmentId && identity.environmentId !== subject.environmentId;
}

async function authorizeUser(
  auth: { action: string; subject: string },
  identity: McpIdentity,
  request: Request
): Promise<boolean> {
  if (identity.kind === "uat" && (identity.organizationId || identity.environmentId)) return false;
  if (!(await authenticate(identity, request, {}))) return false;
  // Without an org the plugin's ability denies everything, so cap-check delegated tokens directly.
  if (identity.kind === "pat") return true;
  return buildJwtAbility(identity.cap ?? CAPLESS_USER_ACTOR_SCOPES).can(auth.action, {
    type: auth.subject,
  });
}

async function authorize(
  auth: McpToolAuth,
  args: unknown,
  identity: McpIdentity,
  request: Request
): Promise<{ ok: boolean; subject: McpSubject | null }> {
  if ("public" in auth) return { ok: true, subject: null };
  if ("user" in auth) return { ok: await authorizeUser(auth, identity, request), subject: null };

  const subject = await resolveMcpSubject(args, identity);
  if (!subject) return { ok: false, subject: null };
  if (outsideTokenScope(identity, subject)) return { ok: false, subject };

  const ability = await authenticate(identity, request, {
    organizationId: subject.organizationId,
    projectId: subject.projectId,
  });
  if (!ability) return { ok: false, subject };

  const resource = subject.environmentType
    ? { type: auth.subject, envType: subject.environmentType }
    : { type: auth.subject };
  return { ok: ability.can(auth.action, resource), subject };
}

export function withMcpToolAuth<TArgs>(
  auth: McpToolAuth,
  handler: (args: TArgs, ctx: McpToolContext) => Promise<McpToolResult>,
  tool: string
) {
  return async (args: TArgs, identity: McpIdentity, request: Request): Promise<McpToolResult> => {
    const startedAt = performance.now();
    let outcome: Outcome = "error";
    let subject: McpSubject | null = null;

    try {
      const authorization = await authorize(auth, args, identity, request);
      subject = authorization.subject;
      if (!authorization.ok) {
        outcome = "denied";
        return denied();
      }

      const result = await handler(args, { identity, subject, request });
      outcome = result.isError ? "error" : "ok";
      return result;
    } catch (error) {
      logger.error("mcp.tool failed", { tool, error });
      return failed();
    } finally {
      logger.info("mcp.tool", {
        userId: identity.userId,
        tokenKind: identity.kind,
        clientId: identity.kind === "uat" ? identity.clientId : undefined,
        tool,
        organizationId: subject?.organizationId,
        projectId: subject?.projectId,
        outcome,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  };
}
