import type { OAuthClient } from "@trigger.dev/database";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { getCsrfToken, verifyCsrfToken } from "~/services/csrf.server";
import { AUTHORIZATION_CODE_TTL_MS } from "~/services/personalAccessToken.server";
import {
  authorizationRedirectUrl,
  buildOAuthRedirect,
  findOAuthCode,
  oauthCodeKey,
} from "./authorize.server";

type ClientIdentity = {
  primary: string;
  unverified: boolean;
  selfReported?: string;
};

type ClientRow = Pick<OAuthClient, "kind" | "clientId" | "displayName" | "selfReportedName">;

function hostOf(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function originOf(value: string) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return value;
  }
}

/** Identity comes only from the OAuthClient row, never from the request. */
function describeOAuthClient(client: ClientRow, redirectUri?: string): ClientIdentity {
  switch (client.kind) {
    case "PREREGISTERED":
      return { primary: client.displayName ?? client.clientId, unverified: false };
    case "CIMD":
      return {
        primary: hostOf(client.clientId),
        unverified: false,
        selfReported: client.selfReportedName ?? undefined,
      };
    default:
      return {
        primary: redirectUri
          ? `Unverified application (${originOf(redirectUri)})`
          : "Unverified application",
        unverified: true,
        selfReported: client.selfReportedName ?? undefined,
      };
  }
}

export async function describeOAuthClientName(clientId: string): Promise<string> {
  const row = await $replica.oAuthClient.findFirst({
    where: { clientId },
    select: {
      kind: true,
      clientId: true,
      displayName: true,
      selfReportedName: true,
    },
  });
  if (!row) return hostOf(clientId);
  const { primary, selfReported, unverified } = describeOAuthClient(row);
  if (!selfReported) return primary;
  if (!unverified) return `${selfReported} (${primary})`;
  return `"${selfReported}" (unverified)`;
}

const SCOPE_LABEL_OVERRIDES: Record<string, string> = {
  "manage:project": "Manage project settings",
  "read:batch": "Read batches",
  "read:envvars": "Read environment variable names",
  "read:query": "Run read-only queries",
  "trigger:tasks": "Trigger tasks",
  "update:prompts": "Update prompts",
  "write:alerts": "Create and resolve alerts",
  "write:batch": "Manage batches",
  "write:branches": "Manage preview branches",
  "write:deployments": "Manage deployments",
  "write:errors": "Resolve and ignore errors",
  "write:projects": "Create projects",
  "write:query": "Run queries",
  "write:runs": "Cancel and replay runs",
  "write:sessions": "Send to and end agent sessions",
  "write:tasks": "Manage tasks",
  "write:waitpoints": "Complete waitpoints",
  "write:webhooks": "Manage webhooks",
};

export function describeScopes(scopes: string[]): string[] {
  if (scopes.length === 0) return ["Default access for this application"];
  return scopes.map((scope) => {
    if (Object.hasOwn(SCOPE_LABEL_OVERRIDES, scope)) return SCOPE_LABEL_OVERRIDES[scope];
    const [verb, resource] = scope.split(":");
    return verb === "read" && resource ? `Read ${resource}` : scope;
  });
}

/** The authorize request that makes a fresh code for whoever signs in next. */
function buildReauthorizePath(
  row: {
    redirectUri: string;
    codeChallenge: string | null;
    scope: string[];
    resource: string | null;
    oauthClient: { clientId: string };
  },
  state: string | null
) {
  const params = new URLSearchParams({
    client_id: row.oauthClient.clientId,
    redirect_uri: row.redirectUri,
    response_type: "code",
  });
  if (row.codeChallenge) {
    params.set("code_challenge", row.codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  params.set("scope", row.scope.join(" "));
  if (row.resource) params.set("resource", row.resource);
  if (state !== null) params.set("state", state);
  return `/oauth/authorize?${params}`;
}

/** Keeps the loader's Set-Cookie, which a route `headers` export would otherwise drop. */
export function consentDocumentHeaders(loaderHeaders: Headers) {
  const headers = new Headers({
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  const setCookie = loaderHeaders.get("Set-Cookie");
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return headers;
}

function startedBy(row: { requestedByUserId: string | null }, userId: string) {
  return row.requestedByUserId === userId;
}

function mintableWhere(code: string, userId: string) {
  return {
    code: oauthCodeKey(code),
    requestedByUserId: userId,
    personalAccessTokenId: null,
    approvedByUserId: null,
    oauthClientId: { not: null },
    createdAt: { gte: new Date(Date.now() - AUTHORIZATION_CODE_TTL_MS) },
  };
}

export type OAuthConsentView =
  | { status: "not_oauth" }
  | { status: "invalid" }
  | { status: "impersonating" }
  | {
      status: "consent";
      client: ClientIdentity;
      scopes: string[];
      reauthorizePath: string;
      csrfToken: string;
      setCookie?: string;
    };

/** `not_oauth` means the code belongs to the CLI flow. */
export async function loadOAuthConsent(
  request: Request,
  code: string,
  userId: string,
  isImpersonating = false,
  prismaClient = prisma
): Promise<OAuthConsentView> {
  const row = await findOAuthCode(code, prismaClient);

  if (!row || !row.oauthClientId) return { status: "not_oauth" };
  if (!env.MCP_SERVER_ENABLED) return { status: "invalid" };
  if (isImpersonating) return { status: "impersonating" };

  const expired = row.createdAt.getTime() < Date.now() - AUTHORIZATION_CODE_TTL_MS;
  if (
    !row.oauthClient ||
    !row.redirectUri ||
    expired ||
    !startedBy(row, userId) ||
    row.approvedByUserId ||
    row.personalAccessTokenId
  ) {
    return { status: "invalid" };
  }

  const { token, setCookie } = await getCsrfToken(request);
  return {
    status: "consent",
    client: describeOAuthClient(row.oauthClient, row.redirectUri),
    scopes: describeScopes(row.scope),
    reauthorizePath: buildReauthorizePath(
      { ...row, redirectUri: row.redirectUri, oauthClient: row.oauthClient },
      new URL(request.url).searchParams.get("state")
    ),
    csrfToken: token,
    setCookie,
  };
}

export type OAuthConsentDecision =
  | { status: "not_oauth" }
  | { status: "invalid" }
  | { status: "csrf" }
  | { status: "impersonating" }
  | { status: "bad_request" }
  | { status: "redirect"; url: string };

export async function decideOAuthConsent(
  request: Request,
  params: {
    code: string;
    userId: string;
    formData: FormData;
    state?: string | null;
    isImpersonating?: boolean;
  },
  prismaClient = prisma
): Promise<OAuthConsentDecision> {
  const row = await findOAuthCode(params.code, prismaClient);
  if (!row || !row.oauthClientId) return { status: "not_oauth" };
  if (!env.MCP_SERVER_ENABLED) return { status: "invalid" };
  if (params.isImpersonating) return { status: "impersonating" };

  if (!(await verifyCsrfToken(request, params.formData.get("csrfToken")))) {
    return { status: "csrf" };
  }
  if (!row.redirectUri || !startedBy(row, params.userId)) return { status: "invalid" };

  const decision = params.formData.get("decision");
  if (decision !== "approve" && decision !== "deny") return { status: "bad_request" };

  const state = params.state ?? null;
  const where = mintableWhere(params.code, params.userId);

  if (decision === "deny") {
    const { count } = await prismaClient.authorizationCode.deleteMany({ where });
    if (count === 0) return { status: "invalid" };
    return {
      status: "redirect",
      url: authorizationRedirectUrl(row.redirectUri, { error: "access_denied" }, state),
    };
  }

  const { count } = await prismaClient.authorizationCode.updateMany({
    where,
    data: { approvedByUserId: params.userId },
  });
  if (count === 0) return { status: "invalid" };

  const url = await buildOAuthRedirect(params.code, state);
  return url ? { status: "redirect", url } : { status: "invalid" };
}
