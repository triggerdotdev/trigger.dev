import { UrlElicitationRequiredError } from "@modelcontextprotocol/server";
import { buildJwtAbility, CAPLESS_USER_ACTOR_SCOPES, type RbacAbility } from "@trigger.dev/rbac";
import { logger } from "~/services/logger.server";
import { resolveAndRecheckUserActorClaims } from "~/services/personalAccessToken.server";
import { rbac } from "~/services/rbac.server";
import {
  confirmationClient,
  confirmationDigest,
  confirmationPreview,
  confirmationSubject,
  confirmationTokenId,
  describeMcpSubject,
} from "../confirm/confirmation.server";
import type { McpConfirmationStore } from "../confirm/store.server";
import { requiresApproval } from "./approval.server";
import { resolveMcpSubject } from "./resolveSubject.server";
import type {
  McpConfirmSpec,
  McpIdentity,
  McpRequestExtra,
  McpSubject,
  McpToolAuth,
  McpToolContext,
} from "./types";

export type { McpToolContext } from "./types";

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type McpGateOptions = {
  confirmations?: () => McpConfirmationStore;
  confirmationErrorMode?: "rpc-error" | "tool-error";
};

// Loaded on first confirm so importing the gate doesn't parse env.
async function confirmationDefaults(options: McpGateOptions) {
  if (options.confirmations && options.confirmationErrorMode) {
    return { store: options.confirmations(), mode: options.confirmationErrorMode };
  }
  const instance = await import("../confirm/storeInstance.server");
  return {
    store: (options.confirmations ?? instance.getMcpConfirmationStore)(),
    mode: options.confirmationErrorMode ?? instance.mcpConfirmationErrorMode,
  };
}

type Outcome = "ok" | "denied" | "error" | "pending" | "confirmed";

const NO_EXTRA: McpRequestExtra = { signal: new AbortController().signal, requestId: "" };

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
): Promise<{ ok: boolean; subject: McpSubject | null; ability?: RbacAbility }> {
  if ("public" in auth) return { ok: true, subject: null };
  if ("user" in auth) return { ok: await authorizeUser(auth, identity, request), subject: null };

  const subject = await (auth.resolveSubject ?? resolveMcpSubject)(args, identity);
  if (!subject) return { ok: false, subject: null };
  if (outsideTokenScope(identity, subject)) return { ok: false, subject };

  const ability = await authenticate(identity, request, {
    organizationId: subject.organizationId,
    projectId: subject.projectId,
  });
  if (!ability) return { ok: false, subject };

  const id = auth.resourceId?.(args);
  const resource = {
    type: auth.subject,
    ...(id ? { id } : {}),
    ...(subject.environmentType ? { envType: subject.environmentType } : {}),
  };
  return { ok: ability.can(auth.action, resource), subject, ability };
}

async function confirm(
  store: McpConfirmationStore,
  tool: string,
  spec: true | McpConfirmSpec,
  args: unknown,
  identity: McpIdentity,
  subject: McpSubject | null
): Promise<
  { approved: true; id: string } | { approved: false; id: string; url: string; message: string }
> {
  const lookup = {
    userId: identity.userId,
    tokenId: confirmationTokenId(identity),
    client: confirmationClient(identity),
    tool,
    argsDigest: confirmationDigest(tool, args, subject),
  };
  const consumed = await store.consumeApproved(lookup);
  if (consumed) return { approved: true, id: consumed.id };

  const { id, url } = await store.createPending({
    ...lookup,
    clientId: identity.kind === "uat" ? (identity.clientId ?? "Unknown client") : undefined,
    subject: confirmationSubject(subject),
    ...(await confirmationPreview(tool, spec, args, subject)),
  });
  const target = await describeMcpSubject(subject);
  return {
    approved: false,
    id,
    url,
    message: `Confirmation required. Open ${url} to approve "${tool}" for ${target}, then call the same tool again with identical arguments.`,
  };
}

export function withMcpToolAuth<TArgs>(
  auth: McpToolAuth,
  handler: (args: TArgs, ctx: McpToolContext) => Promise<McpToolResult>,
  tool: string,
  options: McpGateOptions = {}
) {
  return async (
    args: TArgs,
    identity: McpIdentity,
    request: Request,
    extra: McpRequestExtra = NO_EXTRA
  ): Promise<McpToolResult> => {
    const startedAt = performance.now();
    let outcome: Outcome = "error";
    let subject: McpSubject | null = null;
    let confirmationId: string | undefined;

    try {
      const authorization = await authorize(auth, args, identity, request);
      subject = authorization.subject;
      if (!authorization.ok) {
        outcome = "denied";
        return denied();
      }

      let confirmation: { id: string } | undefined;
      const approval = requiresApproval(auth);
      if (approval) {
        const { store, mode } = await confirmationDefaults(options);
        const check = await confirm(store, tool, approval, args, identity, subject);
        confirmationId = check.id;
        if (!check.approved) {
          outcome = "pending";
          if (mode === "tool-error" && extra.era !== "modern") {
            return { content: [{ type: "text", text: check.message }], isError: true };
          }
          throw new UrlElicitationRequiredError(
            [{ mode: "url", message: check.message, elicitationId: check.id, url: check.url }],
            check.message
          );
        }
        confirmation = { id: check.id };
      }

      const result = await handler(args, {
        identity,
        subject,
        request,
        ability: authorization.ability,
        signal: extra.signal,
        requestId: extra.requestId,
        confirmation,
      });
      outcome = result.isError ? "error" : confirmation ? "confirmed" : "ok";
      return result;
    } catch (error) {
      if (error instanceof UrlElicitationRequiredError) throw error;
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
        confirmationId,
        outcome,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  };
}
