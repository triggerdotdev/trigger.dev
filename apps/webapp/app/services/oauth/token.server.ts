import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import {
  isUserActorToken,
  personalAccessTokenExpiry,
  signUserActorToken,
  verifyUserActorToken,
} from "@trigger.dev/rbac";
import type { AdminAuditSourceEndpoint, AuditLogActor } from "@trigger.dev/plugins";
import { randomBytes } from "node:crypto";
import { $transaction, prisma } from "~/db.server";
import { recordAdminPatCreated } from "~/services/adminAudit/adminAuditContext.server";
import { SYSTEM_ACTOR, userActor } from "~/services/credentialFingerprints.server";
import { env } from "~/env.server";
import {
  AUTHORIZATION_CODE_TTL_MS,
  codeChallengeFor,
  createPersonalAccessToken,
  recordPersonalAccessTokenCreated,
  recordPersonalAccessTokenRevoked,
  safeEqual,
  updateLastAccessedAtIfStale,
} from "~/services/personalAccessToken.server";
import { hashToken } from "~/utils/tokens.server";
import { oauthCodeKey } from "./authorize.server";
import { clientDisplayName } from "./clients.server";
import { mcpResource, oauthError, type OAuthError } from "./metadata.server";

const ACCESS_TOKEN_MAX_SECONDS = 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LIVE_GRANTS = 10;
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000;

type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

export type TokenResult = { ok: true; body: TokenResponse } | { ok: false; body: OAuthError };

const invalidGrant = (description: string): TokenResult => ({
  ok: false,
  body: oauthError("invalid_grant", description),
});

export type MintAccessToken = typeof mintMcpAccessToken;

function mintMcpAccessToken(opts: {
  userId: string;
  client: string;
  pat: string;
  cap: string[];
  expiresAt: number;
}) {
  return signUserActorToken(env.SESSION_SECRET, {
    userId: opts.userId,
    client: opts.client,
    pat: opts.pat,
    cap: opts.cap,
    expirationTime: opts.expiresAt,
    audience: mcpResource(),
  });
}

/** Writes a refresh handle, then signs the access token last so a signing failure rolls back. */
async function issueTokens(
  tx: PrismaClientOrTransaction,
  sign: MintAccessToken,
  grant: {
    userId: string;
    clientId: string;
    oauthClientId: string;
    patId: string;
    patExpiresAt: Date | null;
    scope: string[];
    resource: string;
  }
): Promise<{ body: TokenResponse; refreshTokenId: string }> {
  const now = Math.floor(Date.now() / 1000);
  const patSeconds = grant.patExpiresAt
    ? Math.floor(grant.patExpiresAt.getTime() / 1000) - now
    : ACCESS_TOKEN_MAX_SECONDS;
  const expiresIn = Math.max(0, Math.min(ACCESS_TOKEN_MAX_SECONDS, patSeconds));

  const refreshToken = randomBytes(32).toString("base64url");
  const row = await tx.oAuthRefreshToken.create({
    data: {
      hashedToken: hashToken(refreshToken),
      personalAccessTokenId: grant.patId,
      oauthClientId: grant.oauthClientId,
      scope: grant.scope,
      resource: grant.resource,
      idleExpiresAt: new Date(Date.now() + env.OAUTH_GRANT_IDLE_DAYS * DAY_MS),
    },
    select: { id: true },
  });
  await tx.oAuthClient.updateMany({
    where: {
      id: grant.oauthClientId,
      OR: [
        { lastUsedAt: null },
        { lastUsedAt: { lt: new Date(Date.now() - LAST_USED_THROTTLE_MS) } },
      ],
    },
    data: { lastUsedAt: new Date() },
  });

  const accessToken = await sign({
    userId: grant.userId,
    client: grant.clientId,
    pat: grant.patId,
    cap: grant.scope,
    expiresAt: now + expiresIn,
  });

  return {
    body: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: grant.scope.join(" "),
    },
    refreshTokenId: row.id,
  };
}

/** Exchanges an approved code for tokens. The grant PAT is minted here. */
export async function exchangeAuthorizationCode(
  params: URLSearchParams,
  auditSource: AdminAuditSourceEndpoint,
  sign: MintAccessToken = mintMcpAccessToken
): Promise<TokenResult> {
  const codeValue = params.get("code");
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const codeVerifier = params.get("code_verifier");
  if (!codeValue || !clientId || !redirectUri || !codeVerifier) {
    return {
      ok: false,
      body: oauthError(
        "invalid_request",
        "code, client_id, redirect_uri and code_verifier are required"
      ),
    };
  }

  const code = await prisma.authorizationCode.findFirst({
    where: {
      code: oauthCodeKey(codeValue),
      createdAt: { gte: new Date(Date.now() - AUTHORIZATION_CODE_TTL_MS) },
    },
    include: { oauthClient: true },
  });

  if (
    !code?.oauthClient ||
    !code.approvedByUserId ||
    code.approvedByUserId !== code.requestedByUserId ||
    !code.codeChallenge ||
    !code.resource
  ) {
    return invalidGrant("Invalid, expired or unapproved code");
  }
  if (code.oauthClient.clientId !== clientId || code.redirectUri !== redirectUri) {
    return invalidGrant("Code was issued to another client or redirect_uri");
  }
  if (!safeEqual(codeChallengeFor(codeVerifier), code.codeChallenge)) {
    return invalidGrant("PKCE verification failed");
  }
  const resource = params.get("resource");
  if (resource !== null && resource !== code.resource) {
    return { ok: false, body: oauthError("invalid_target", "resource does not match the code") };
  }
  if (code.personalAccessTokenId) {
    await revokeGrant(code.personalAccessTokenId, "code_replay");
    return invalidGrant("Code already used");
  }

  const userId = code.approvedByUserId;
  const client = code.oauthClient;
  const codeResource = code.resource;

  const result = await $transaction(prisma, "oauth.exchangeAuthorizationCode", async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`oauth_grant:${userId}:${client.id}`}))`;
    const current = await tx.authorizationCode.findFirst({
      where: { id: code.id },
      select: { personalAccessTokenId: true },
    });
    if (!current) return { replayedPatId: null };
    if (current.personalAccessTokenId) return { replayedPatId: current.personalAccessTokenId };

    const replaced =
      client.kind === "PREREGISTERED"
        ? await revokeGrants(tx, { userId, oauthClientId: client.id })
        : [];

    const pat = await createPersonalAccessToken(
      {
        name: `${clientDisplayName(client)} (MCP)`,
        userId,
        auditSource,
        expiresAt: new Date(Date.now() + env.OAUTH_GRANT_ABSOLUTE_DAYS * DAY_MS),
        idleTimeoutSeconds: env.OAUTH_GRANT_IDLE_DAYS * (DAY_MS / 1000),
        oauthClientId: client.id,
        skipAudit: true,
      },
      tx
    );
    await tx.authorizationCode.update({
      where: { id: code.id },
      data: { personalAccessTokenId: pat.id },
    });
    const beyondCap = await revokeGrantsBeyondCap(tx, userId, client.id);

    const issued = await issueTokens(tx, sign, {
      userId,
      clientId,
      oauthClientId: client.id,
      patId: pat.id,
      patExpiresAt: pat.expiresAt,
      scope: code.scope,
      resource: codeResource,
    });
    // Not the token itself: only what its events need leaves the transaction.
    const created = {
      id: pat.id,
      name: pat.name,
      obfuscatedToken: pat.obfuscatedToken,
      expiresAt: pat.expiresAt,
      oauthClientId: client.id,
    };
    return { body: issued.body, pat: created, replaced, beyondCap };
  });

  if (!result) return invalidGrant("Code already used");
  if ("replayedPatId" in result) {
    if (result.replayedPatId) await revokeGrant(result.replayedPatId, "code_replay");
    return invalidGrant("Code already used");
  }
  void recordAdminPatCreated({
    userId,
    tokenId: result.pat.id,
    name: result.pat.name,
    source: auditSource,
  });
  // Recorded once the exchange commits: `skipAudit` kept them out of the transaction.
  recordPersonalAccessTokenCreated(result.pat, userActor(userId), "api");
  recordGrantsRevoked(result.replaced, "replaced");
  recordGrantsRevoked(result.beyondCap, "grant_cap");
  return { ok: true, body: result.body };
}

/** Why a grant's token was revoked, as its `pat.revoked` event says. */
type GrantRevocationReason =
  /** The user authorized a pre-registered client again, which replaces its earlier grants. */
  | "replaced"
  /** The user has more live grants for the client than the cap: the oldest go. */
  | "grant_cap"
  /** An authorization code was presented twice. */
  | "code_replay"
  /** A used refresh token was presented again. */
  | "refresh_reuse"
  /** The client asked to revoke the token (RFC 7009). */
  | "client_revoked";

type RevokedGrant = Awaited<ReturnType<typeof revokeGrants>>[number];

/** Revokes grant tokens. Inside a transaction, record the result once it commits. */
function revokeGrants(
  tx: PrismaClientOrTransaction,
  where: {
    id?: string | { in: string[] };
    userId?: string;
    oauthClientId?: string | { not: null };
  }
) {
  return tx.personalAccessToken.updateManyAndReturn({
    where: { ...where, revokedAt: null },
    data: { revokedAt: new Date() },
    select: {
      id: true,
      name: true,
      userId: true,
      obfuscatedToken: true,
      hashedToken: true,
      revokedAt: true,
      oauthClientId: true,
    },
  });
}

async function revokeGrant(personalAccessTokenId: string, reason: GrantRevocationReason) {
  recordGrantsRevoked(await revokeGrants(prisma, { id: personalAccessTokenId }), reason);
}

/**
 * Marks each token's fingerprint revoked and records `pat.revoked`. A replayed code or refresh
 * token is our response to a possible attack, not the user's doing, so `system` revokes those.
 */
function recordGrantsRevoked(tokens: RevokedGrant[], reason: GrantRevocationReason) {
  const bySystem = reason === "code_replay" || reason === "refresh_reuse";
  for (const token of tokens) {
    const revokedBy: AuditLogActor = bySystem ? SYSTEM_ACTOR : userActor(token.userId);
    recordPersonalAccessTokenRevoked(token, {
      reason: "revoked",
      revokedBy,
      auditReason: reason,
      source: "api",
    });
  }
}

/** Keeps at most MAX_LIVE_GRANTS grant PATs per user and client, revoking the oldest. */
async function revokeGrantsBeyondCap(
  tx: PrismaClientOrTransaction,
  userId: string,
  oauthClientId: string
) {
  const stale = await tx.personalAccessToken.findMany({
    where: {
      userId,
      oauthClientId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: MAX_LIVE_GRANTS,
    select: { id: true },
  });
  if (stale.length === 0) return [];
  return revokeGrants(tx, { id: { in: stale.map((pat) => pat.id) } });
}

/** Rotates a refresh handle. Presenting a used handle revokes the whole grant. */
export async function exchangeRefreshToken(
  params: URLSearchParams,
  sign: MintAccessToken = mintMcpAccessToken
): Promise<TokenResult> {
  const refreshToken = params.get("refresh_token");
  const clientId = params.get("client_id");
  if (!refreshToken || !clientId) {
    return {
      ok: false,
      body: oauthError("invalid_request", "refresh_token and client_id are required"),
    };
  }

  const row = await prisma.oAuthRefreshToken.findFirst({
    where: { hashedToken: hashToken(refreshToken) },
    include: { personalAccessToken: true, oauthClient: true },
  });
  if (!row || row.oauthClient.clientId !== clientId) {
    return invalidGrant("Invalid refresh token");
  }

  const now = new Date();
  if (row.usedAt) {
    await revokeGrant(row.personalAccessTokenId, "refresh_reuse");
    return invalidGrant("Refresh token already used");
  }

  const pat = row.personalAccessToken;
  if (row.idleExpiresAt <= now || pat.revokedAt || personalAccessTokenExpiry(pat, now)) {
    return invalidGrant("Grant expired or revoked");
  }

  const requested = params.get("scope");
  const scope = requested ? [...new Set(requested.trim().split(/\s+/))] : row.scope;
  if (!scope.every((s) => row.scope.includes(s))) {
    return { ok: false, body: oauthError("invalid_scope", "scope exceeds the grant") };
  }

  await updateLastAccessedAtIfStale(pat.id, pat.lastAccessedAt);

  const body = await $transaction(prisma, "oauth.exchangeRefreshToken", async (tx) => {
    const claimed = await tx.oAuthRefreshToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return null;

    const issued = await issueTokens(tx, sign, {
      userId: pat.userId,
      clientId,
      oauthClientId: row.oauthClientId,
      patId: pat.id,
      patExpiresAt: pat.expiresAt,
      scope,
      resource: row.resource,
    });
    await tx.oAuthRefreshToken.update({
      where: { id: row.id },
      data: { replacedById: issued.refreshTokenId },
    });
    return issued.body;
  });

  if (!body) {
    await revokeGrant(row.personalAccessTokenId, "refresh_reuse");
    return invalidGrant("Refresh token already used");
  }
  return { ok: true, body };
}

/** RFC 7009: revoking a refresh handle or access token ends its grant. Unknown tokens are ignored. */
export async function revokeToken(params: URLSearchParams): Promise<void> {
  const token = params.get("token");
  if (!token) return;
  const clientId = params.get("client_id");

  if (isUserActorToken(token)) {
    const claims = await verifyUserActorToken(env.SESSION_SECRET, token, {
      audience: mcpResource(),
    });
    if (!claims?.pat || (clientId && clientId !== claims.client)) return;
    recordGrantsRevoked(
      await revokeGrants(prisma, { id: claims.pat, oauthClientId: { not: null } }),
      "client_revoked"
    );
    return;
  }

  const row = await prisma.oAuthRefreshToken.findFirst({
    where: { hashedToken: hashToken(token) },
    select: { personalAccessTokenId: true, oauthClient: { select: { clientId: true } } },
  });
  if (!row) return;
  if (clientId && clientId !== row.oauthClient.clientId) return;
  await revokeGrant(row.personalAccessTokenId, "client_revoked");
}
