import { nanoid } from "nanoid";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { AUTHORIZATION_CODE_TTL_MS } from "~/services/personalAccessToken.server";
import { hashToken } from "~/utils/tokens.server";
import { type MetadataTransport } from "./cimdFetch.server";
import { redirectUriMatches, resolveClient } from "./clients.server";
import { mcpResource, oauthError, parseScope, type OAuthError } from "./metadata.server";

export type AuthorizationRequest = {
  oauthClientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string[];
  resource: string;
  state: string | null;
};

export type AuthorizationRequestResult =
  | { ok: true; request: AuthorizationRequest }
  /** The client or redirect URI can't be trusted, so the error is shown, not redirected. */
  | { ok: false; redirect: false; error: OAuthError }
  | { ok: false; redirect: true; error: OAuthError; redirectUri: string; state: string | null };

const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export async function validateAuthorizationRequest(
  params: URLSearchParams,
  transport?: MetadataTransport
): Promise<AuthorizationRequestResult> {
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  if (!clientId || !redirectUri) {
    return {
      ok: false,
      redirect: false,
      error: oauthError("invalid_request", "client_id and redirect_uri are required"),
    };
  }

  const client = await resolveClient(clientId, transport);
  if (!client) {
    return { ok: false, redirect: false, error: oauthError("invalid_client", "Unknown client") };
  }
  if (!client.redirectUris.some((registered) => redirectUriMatches(registered, redirectUri))) {
    return {
      ok: false,
      redirect: false,
      error: oauthError("invalid_request", "redirect_uri is not registered for this client"),
    };
  }

  const state = params.get("state");
  const fail = (error: OAuthError): AuthorizationRequestResult =>
    client.kind !== "PREREGISTERED"
      ? { ok: false, redirect: false, error }
      : { ok: false, redirect: true, error, redirectUri, state };

  if (params.get("response_type") !== "code") {
    return fail(oauthError("unsupported_response_type", "response_type must be code"));
  }

  const codeChallenge = params.get("code_challenge");
  if (
    !codeChallenge ||
    !CODE_CHALLENGE.test(codeChallenge) ||
    params.get("code_challenge_method") !== "S256"
  ) {
    return fail(oauthError("invalid_request", "A S256 code_challenge is required"));
  }

  const requestedScope = params.get("scope");
  const scope = parseScope(requestedScope);
  if (scope && !requestedScope?.trim()) {
    logger.info("oauth.authorize.scope_defaulted", { clientId: client.id });
  }
  if (!scope) {
    return fail(oauthError("invalid_scope", "Requested scope is not supported"));
  }

  const resource = params.get("resource");
  if (resource !== mcpResource()) {
    return fail(oauthError("invalid_target", `resource must be ${mcpResource()}`));
  }

  return {
    ok: true,
    request: { oauthClientId: client.id, redirectUri, codeChallenge, scope, resource, state },
  };
}

/** An impersonating admin must not grant a client access as the user. Throws a 403. */
export function assertNotImpersonating(user: { isImpersonating: boolean }) {
  if (user.isImpersonating) {
    throw Response.json(oauthError("access_denied", "Not available while impersonating a user"), {
      status: 403,
    });
  }
}

/** OAuth codes are stored hashed; look them up by this key, never by the plaintext code. */
export function oauthCodeKey(code: string) {
  return hashToken(code);
}

/** Loads an OAuth authorization code row by its plaintext code. */
export function findOAuthCode(code: string, prismaClient = prisma) {
  return prismaClient.authorizationCode.findFirst({
    where: { code: oauthCodeKey(code) },
    include: { oauthClient: true },
  });
}

/** Creates the unapproved code the consent page shows. Only `userId` may approve it. */
export async function createOAuthAuthorizationCode(request: AuthorizationRequest, userId: string) {
  const code = nanoid(64);
  const row = await prisma.authorizationCode.create({
    data: {
      code: oauthCodeKey(code),
      requestedByUserId: userId,
      oauthClientId: request.oauthClientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope: request.scope,
      resource: request.resource,
    },
    select: { id: true },
  });
  return { id: row.id, code };
}

export function consentPath(code: string, state: string | null) {
  const path = `/account/authorization-code/${code}`;
  return state === null ? path : `${path}?${new URLSearchParams({ state })}`;
}

export function authorizationRedirectUrl(
  redirectUri: string,
  params: Record<string, string>,
  state: string | null
) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (state !== null) url.searchParams.set("state", state);
  url.searchParams.set("iss", env.APP_ORIGIN);
  return url.toString();
}

/**
 * Where the consent page sends the browser after approving an OAuth code. `state` is the
 * value the authorize endpoint forwarded on the consent URL. Null for a non-OAuth or expired code.
 */
export async function buildOAuthRedirect(
  code: string,
  state: string | null
): Promise<string | null> {
  const row = await prisma.authorizationCode.findFirst({
    where: {
      code: oauthCodeKey(code),
      oauthClientId: { not: null },
      createdAt: { gte: new Date(Date.now() - AUTHORIZATION_CODE_TTL_MS) },
    },
    select: { redirectUri: true },
  });
  if (!row?.redirectUri) return null;
  return authorizationRedirectUrl(row.redirectUri, { code }, state);
}
