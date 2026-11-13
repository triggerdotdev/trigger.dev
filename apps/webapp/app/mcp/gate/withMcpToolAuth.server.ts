import { UrlElicitationRequiredError } from "@modelcontextprotocol/server";
import { buildJwtAbility, CAPLESS_USER_ACTOR_SCOPES, type RbacAbility } from "@trigger.dev/rbac";
import { logger } from "~/services/logger.server";
import { resolveAndRecheckUserActorClaims } from "~/services/personalAccessToken.server";
import { mcpResource } from "~/services/oauth/metadata.server";
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
import { fenceUntrusted } from "./fence.server";
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

type Outcome =
  | "ok"
  | "denied"
  | "insufficient_scope"
  | "forbidden"
  | "user_denied"
  | "error"
  | "pending"
  | "confirmed";

type Denial = "denied" | "insufficient_scope" | "forbidden";

const NO_EXTRA: McpRequestExtra = { signal: new AbortController().signal, requestId: "" };

const errorText = (text: string): McpToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

const requiredScopes = (auth: { action: string; subject: string }) => [
  `${auth.action}:${auth.subject}`,
];

export function missingScopes(
  auth: McpToolAuth,
  identity: McpIdentity,
  resource?: { type: string; id?: string }
): string[] {
  if ("public" in auth || identity.kind !== "uat") return [];
  const cap = identity.cap ?? CAPLESS_USER_ACTOR_SCOPES;
  const scope = requiredScopes(auth)[0];
  const allowed = resource
    ? buildJwtAbility(cap).can(auth.action, resource)
    : buildJwtAbility(cap).can(auth.action, { type: auth.subject }) ||
      cap.some((s) => s.startsWith(`${scope}:`));
  return allowed ? [] : [scope];
}

function denialResult(denial: Denial, auth: McpToolAuth): McpToolResult {
  if ("public" in auth || denial === "denied") return errorText("Not authorized");
  if (denial === "insufficient_scope") {
    return errorText(`Insufficient scope: this tool requires ${requiredScopes(auth).join(", ")}`);
  }
  return errorText(
    `Not authorized: your role in this organization does not allow ${auth.action} on ${auth.subject}`
  );
}

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

  const audience = mcpResource();
  const result = await rbac.authenticateUserActor(request, context, { audience });
  if (!result.ok) return null;
  const bearer = request.headers
    .get("Authorization")
    ?.replace(/^Bearer /, "")
    .trim();
  const claims =
    bearer && (await resolveAndRecheckUserActorClaims(result.claims, bearer, audience));
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
): Promise<Denial | null> {
  if (identity.kind === "uat" && (identity.organizationId || identity.environmentId)) {
    return "denied";
  }
  if (!(await authenticate(identity, request, {}))) return "denied";
  // Without an org the plugin's ability denies everything, so cap-check delegated tokens directly.
  if (identity.kind === "pat") return null;
  const cap = buildJwtAbility(identity.cap ?? CAPLESS_USER_ACTOR_SCOPES);
  return cap.can(auth.action, { type: auth.subject }) ? null : "insufficient_scope";
}

type Authorization = {
  denial: Denial | null;
  subject: McpSubject | null;
  ability?: RbacAbility;
};

async function authorize(
  auth: McpToolAuth,
  args: unknown,
  identity: McpIdentity,
  request: Request
): Promise<Authorization> {
  if ("public" in auth) return { denial: null, subject: null };
  if ("user" in auth) {
    return { denial: await authorizeUser(auth, identity, request), subject: null };
  }

  const subject = await (auth.resolveSubject ?? resolveMcpSubject)(args, identity);
  if (!subject) return { denial: "denied", subject: null };
  if (outsideTokenScope(identity, subject)) return { denial: "denied", subject };

  const ability = await authenticate(identity, request, {
    organizationId: subject.organizationId,
    projectId: subject.projectId,
  });
  if (!ability) return { denial: "denied", subject };

  const id = auth.resourceId?.(args);
  const resource = {
    type: auth.subject,
    ...(id ? { id } : {}),
    ...(subject.environmentType ? { envType: subject.environmentType } : {}),
  };
  if (ability.can(auth.action, resource)) return { denial: null, subject, ability };
  const denial = missingScopes(auth, identity, resource).length
    ? "insufficient_scope"
    : "forbidden";
  return { denial, subject, ability };
}

async function confirm(
  store: McpConfirmationStore,
  tool: string,
  spec: true | McpConfirmSpec,
  args: unknown,
  identity: McpIdentity,
  subject: McpSubject | null
): Promise<
  | { approved: true; id: string }
  | { approved: false; id: string; url: string; message: string }
  | { approved: false; denied: true; id: string }
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

  const created = await store.createPending({
    ...lookup,
    clientId: identity.kind === "uat" ? (identity.clientId ?? "Unknown client") : undefined,
    subject: confirmationSubject(subject),
    ...(await confirmationPreview(tool, spec, args, subject)),
  });
  if ("denied" in created) return { approved: false, denied: true, id: created.id };
  const { id, url } = created;
  const target = await describeMcpSubject(subject);
  return {
    approved: false,
    id,
    url,
    message: `Confirmation required. Open ${url} to approve "${tool}" for ${fenceUntrusted(target, "confirmation-target")}, then call the same tool again with identical arguments.`,
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
      if (authorization.denial) {
        outcome = authorization.denial;
        return denialResult(authorization.denial, auth);
      }

      let confirmation: { id: string } | undefined;
      const approval = requiresApproval(auth);
      if (approval) {
        const { store, mode } = await confirmationDefaults(options);
        const check = await confirm(store, tool, approval, args, identity, subject);
        confirmationId = check.id;
        if ("denied" in check) {
          outcome = "user_denied";
          return {
            content: [
              {
                type: "text",
                text: `The user denied "${tool}". Do not retry unless the user asks again.`,
              },
            ],
            isError: true,
          };
        }
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
        tokenId: identity.kind === "pat" ? identity.tokenId : identity.sourceTokenId,
        clientId: identity.kind === "uat" ? identity.clientId : undefined,
        tool,
        organizationId: subject?.organizationId,
        projectId: subject?.projectId,
        environmentId: subject?.environmentId,
        confirmationId,
        outcome,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  };
}
