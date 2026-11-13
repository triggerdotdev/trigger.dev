import {
  type PersonalAccessToken,
  type PrismaClientOrTransaction,
  type User,
} from "@trigger.dev/database";
import { compareCliLoginNetworks, needsNetworkConfirmation } from "./cliLoginNetwork.server";
import type { CreateAuthorizationCodeRequest } from "@trigger.dev/core/v3";
import { customAlphabet, nanoid } from "nanoid";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { noteAdminRequest, recordAdminPatCreated } from "./adminAudit/adminAuditContext.server";
import { logger } from "./logger.server";
import { rbac } from "./rbac.server";
import { decryptToken, encryptToken, hashToken } from "~/utils/tokens.server";
import { EncryptedValueSchema as EncryptedSecretValueSchema } from "~/utils/encryptionKeyring.server";
import { env } from "~/env.server";
import {
  isUserActorToken,
  personalAccessTokenExpiry,
  personalAccessTokenExpiryMessage,
  personalAccessTokenValidUntil,
  type PersonalAccessTokenExpiry,
  verifyUserActorToken,
  type UserActorClaims,
} from "@trigger.dev/rbac";
import { personalAccessTokensPath } from "~/utils/pathBuilder";
import { PERSONAL_ACCESS_TOKEN_EXPIRING_SOON_DAYS } from "./personalAccessTokenExpiryEmails.server";
import type { AdminAuditSourceEndpoint } from "@trigger.dev/plugins";

const tokenValueLength = 40;
//lowercase only, removed 0 and l to avoid confusion
const tokenGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", tokenValueLength);

// Skip the lastAccessedAt write if the existing value is already within this
// window. Eliminates per-auth UPDATE churn on a small narrow hot table; the
// /account/tokens UI reads this field at human granularity so a few-minute
// staleness is fine.
export const PAT_LAST_ACCESSED_THROTTLE_MS = 5 * 60 * 1000;

// How long an unconsumed CLI authorization code stays valid. Shared constant so
// the mint and read paths can't drift.
export const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;

const SECONDS_PER_DAY = 24 * 60 * 60;

type CreatePersonalAccessTokenOptions = {
  name: string;
  userId: string;
  // Optional: when provided, persist a TokenRole row alongside the PAT
  // so PAT-authenticated requests pick up that role's permissions
  // (TRI-8749). The dashboard tokens page passes a chosen system role;
  // the CLI auth-code path doesn't pass one (legacy behaviour
  // preserved — those PATs run with no explicit role).
  roleId?: string;
  /** Where the mint came from, for the admin audit trail when the user is an admin. */
  auditSource?: AdminAuditSourceEndpoint;
  /** When the token stops working. Omitted for tokens that don't expire. */
  expiresAt?: Date;
  /** Seconds without use after which the token stops working. Omitted for no idle limit. */
  idleTimeoutSeconds?: number;
};

/** The columns `personalAccessTokenExpiry` reads, for every lookup that checks expiry. */
const expiryColumns = {
  expiresAt: true,
  idleTimeoutSeconds: true,
  lastAccessedAt: true,
  createdAt: true,
} as const;

export type PersonalAccessTokenExpiryOption = {
  /** Lifetime in days. */
  value: number;
  label: string;
};

/**
 * The lifetimes offered when creating a token on the dashboard, the preselected one, and the
 * longest, which also bounds a custom date.
 */
export function personalAccessTokenExpiryOptions(): {
  options: PersonalAccessTokenExpiryOption[];
  defaultDays: number;
  maxDays: number;
} {
  const days = env.PERSONAL_ACCESS_TOKEN_EXPIRY_DAYS;
  const defaultDays = days.includes(env.PERSONAL_ACCESS_TOKEN_DEFAULT_EXPIRY_DAYS)
    ? env.PERSONAL_ACCESS_TOKEN_DEFAULT_EXPIRY_DAYS
    : days[0];
  return {
    options: days.map((value) => ({ value, label: expiryLabel(value) })),
    defaultDays,
    maxDays: Math.max(...days),
  };
}

/**
 * Whether a dashboard-created token can expire at `expiresAt`: in the future, and no later than
 * the end of the UTC day the longest offered lifetime from today. The dashboard sends the end of
 * the chosen UTC day.
 */
export function isAllowedPersonalAccessTokenExpiry(
  expiresAt: Date,
  now: Date = new Date()
): boolean {
  const { maxDays } = personalAccessTokenExpiryOptions();
  const latest = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + maxDays + 1);
  const time = expiresAt.getTime();
  return time > now.getTime() && time <= latest;
}

function expiryLabel(days: number) {
  if (days % 365 === 0) {
    const years = days / 365;
    return years === 1 ? "1 year" : `${years} years`;
  }
  return days === 1 ? "1 day" : `${days} days`;
}

/** The JSON body for a failed `rbac.authenticatePat`, explaining an expired token. */
export function personalAccessTokenAuthFailureBody(failure: {
  error: string;
  code?: PersonalAccessTokenExpiry["code"];
  expiredAt?: Date;
}) {
  if (failure.code && failure.expiredAt) {
    return personalAccessTokenExpiryBody({ code: failure.code, expiredAt: failure.expiredAt });
  }
  return { error: failure.error };
}

/** The tokens page. The public origin, when set, is the one users can open from a CLI, CI log or email. */
export function personalAccessTokensUrl() {
  return `${env.PUBLIC_APP_ORIGIN ?? env.APP_ORIGIN}${personalAccessTokensPath()}`;
}

/** The 401 body for an expired token: a CLI login says to log in again, others where to make a new one. */
export function personalAccessTokenExpiryBody(expiry: PersonalAccessTokenExpiry) {
  return {
    error: personalAccessTokenExpiryMessage(expiry, personalAccessTokensUrl()),
    code: expiry.code,
  };
}

/** Returns obfuscated access tokens that aren't revoked, including expired ones */
export async function getValidPersonalAccessTokens(userId: string) {
  const personalAccessTokens = await prisma.personalAccessToken.findMany({
    select: {
      id: true,
      name: true,
      obfuscatedToken: true,
      createdAt: true,
      lastAccessedAt: true,
      expiresAt: true,
      idleTimeoutSeconds: true,
    },
    where: {
      userId,
      revokedAt: null,
    },
  });

  return personalAccessTokens.map((pat) => ({
    id: pat.id,
    name: pat.name,
    obfuscatedToken: pat.obfuscatedToken,
    createdAt: pat.createdAt,
    lastAccessedAt: pat.lastAccessedAt,
    expiresAt: pat.expiresAt,
    idleTimeoutLabel:
      pat.idleTimeoutSeconds === null
        ? null
        : expiryLabel(Math.round(pat.idleTimeoutSeconds / SECONDS_PER_DAY)),
    isExpired: personalAccessTokenExpiry(pat) !== undefined,
    isExpiringSoon:
      pat.expiresAt !== null &&
      personalAccessTokenExpiry(pat) === undefined &&
      pat.expiresAt.getTime() - Date.now() <=
        PERSONAL_ACCESS_TOKEN_EXPIRING_SOON_DAYS * SECONDS_PER_DAY * 1000,
  }));
}

export type ObfuscatedPersonalAccessToken = Awaited<
  ReturnType<typeof getValidPersonalAccessTokens>
>[number];

/**
 * Gets a PersonalAccessToken from an Auth Code, this only works within 10 mins of the auth code being created.
 * Codes are single use: the request that discloses the token also deletes the code.
 *
 * A code minted with a PKCE challenge only discloses its token to a caller holding both the
 * matching verifier and the approval code, which reaches only the browser that approved it.
 * Codes minted without a challenge are only honoured until `CLI_LOGIN_LEGACY_UNTIL`.
 */
export async function getPersonalAccessTokenFromAuthorizationCode(
  authorizationCode: string,
  proof: { codeVerifier?: string; approvalCode?: string } = {}
) {
  // Only allow authorization codes created within the short consent window.
  const validAfter = new Date(Date.now() - AUTHORIZATION_CODE_TTL_MS);
  const code = await prisma.authorizationCode.findFirst({
    select: {
      id: true,
      codeChallenge: true,
      approvalCodeHash: true,
      personalAccessToken: true,
    },
    where: {
      code: authorizationCode,
      createdAt: {
        gte: validAfter,
      },
    },
  });
  if (!code || code.personalAccessToken?.revokedAt) {
    throw new Error("Invalid authorization code, or code expired");
  }

  if (!code.codeChallenge && !isLegacyCliLoginAllowed()) {
    throw new Error(CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE);
  }

  //there's no PersonalAccessToken associated with this code
  if (!code.personalAccessToken) {
    return {
      token: null,
    };
  }

  if (code.codeChallenge) {
    const verified =
      proof.codeVerifier !== undefined &&
      proof.approvalCode !== undefined &&
      code.approvalCodeHash !== null &&
      safeEqual(codeChallengeFor(proof.codeVerifier), code.codeChallenge) &&
      safeEqual(hashToken(normalizeApprovalCode(proof.approvalCode)), code.approvalCodeHash);

    if (!verified) {
      throw new Error("Invalid authorization code, or code expired");
    }
  }

  const consumed = await prisma.authorizationCode.deleteMany({ where: { id: code.id } });
  if (consumed.count === 0) {
    throw new Error("Invalid authorization code, or code expired");
  }

  const decryptedToken = decryptPersonalAccessToken(code.personalAccessToken);
  return {
    token: {
      token: decryptedToken,
      obfuscatedToken: code.personalAccessToken.obfuscatedToken,
    },
  };
}

export async function revokePersonalAccessToken(tokenId: string, userId: string) {
  const result = await prisma.personalAccessToken.updateMany({
    where: {
      id: tokenId,
      userId,
    },
    data: {
      revokedAt: new Date(),
    },
  });

  if (result.count === 0) {
    throw new Error("PAT not found or already revoked");
  }
}

export type PersonalAccessTokenAuthenticationResult = {
  userId: string;
  /** The PAT row id. Absent for delegated user-actor tokens. */
  tokenId?: string;
  /**
   * Verified claims when the caller presented a delegated user-actor token. They ride on the
   * result so no caller can hold the actor without its environment scope.
   */
  userActor?: UserActorClaims;
  /** When the PAT stops working, if it expires. Anything minted from it shouldn't outlive it. */
  validUntil?: Date;
};

/**
 * Smart-skip the `lastAccessedAt` write when the cached value is already
 * within the throttle window. Saves one DB roundtrip per "fresh" auth.
 *
 * Two layers of throttling: JS-side (`Date.now() - lastAccessedAt.getTime()`)
 * elides the SQL entirely when the caller already has a recent timestamp;
 * SQL-side `WHERE` clause inside the `updateMany` guards against concurrent
 * auths racing to a double-write when the JS check decides to fire.
 *
 * Called from both the legacy PAT flow (`authenticatePersonalAccessToken`)
 * and the apiBuilder's RBAC-routed PAT flow (which gets `lastAccessedAt`
 * from `rbac.authenticatePat`'s result). Keeps the throttle policy in one
 * place rather than expecting every plugin implementer to re-implement it.
 *
 * Returns the last-used time now in effect: the cached value when it was fresh, otherwise now.
 */
export async function updateLastAccessedAtIfStale(
  tokenId: string,
  lastAccessedAt: Date | null
): Promise<Date> {
  if (lastAccessedAt && Date.now() - lastAccessedAt.getTime() <= PAT_LAST_ACCESSED_THROTTLE_MS) {
    return lastAccessedAt; // fresh — no roundtrip
  }
  const now = new Date();
  // If a concurrent request wins the conditional write, it stored a time within the throttle
  // window of `now`, so `now` is still the last-used time to within that window.
  await prisma.personalAccessToken.updateMany({
    where: {
      id: tokenId,
      revokedAt: null,
      OR: [
        { lastAccessedAt: null },
        { lastAccessedAt: { lt: new Date(now.getTime() - PAT_LAST_ACCESSED_THROTTLE_MS) } },
      ],
    },
    data: { lastAccessedAt: now },
  });
  return now;
}

const AuthorizationHeaderSchema = z.string().regex(/^Bearer .+$/);

export async function authenticateApiRequestWithPersonalAccessToken(
  request: Request
): Promise<PersonalAccessTokenAuthenticationResult | undefined> {
  const token = getPersonalAccessTokenFromRequest(request);
  if (!token) {
    return;
  }

  // PAT-only: this helper checks no scopes and no capability context, and its callers include
  // actions and the admin gate. A delegated token is refused at the entrance and reaches the
  // API through the actor-aware routes instead, which do enforce its claims.
  if (isUserActorToken(token)) {
    logger.warn("Rejected a user-actor token at the PAT-only authentication helper");
    return;
  }

  return authenticatePersonalAccessToken(token);
}

export type AdminAuthenticationResult =
  | { ok: true; user: User }
  | { ok: false; status: 401 | 403; message: string; code?: string };

/**
 * Authenticates a request via personal access token and checks the user is
 * an admin. Returns a discriminated result so callers can shape the failure
 * (throw a Response, wrap in neverthrow, return JSON, etc.) to fit their
 * context. See `requireAdminApiRequest` for the Remix loader/action wrapper.
 */
export async function authenticateAdminRequest(
  request: Request
): Promise<AdminAuthenticationResult> {
  const authResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authResult) {
    noteAdminRequest(request, { actor: { kind: "unauthenticated" }, captureBody: false });
    const expiry = await getPersonalAccessTokenExpiry(request);
    if (expiry) {
      const { error, code } = personalAccessTokenExpiryBody(expiry);
      return { ok: false, status: 401, message: error, code };
    }
    return { ok: false, status: 401, message: "Invalid or Missing API key" };
  }

  const user = await prisma.user.findFirst({
    where: { id: authResult.userId },
  });

  if (!user) {
    noteAdminRequest(request, { actor: { kind: "unauthenticated" }, captureBody: false });
    return { ok: false, status: 401, message: "Invalid or Missing API key" };
  }

  noteAdminRequest(request, {
    actor: {
      kind: "user_pat",
      userId: user.id,
      email: user.email,
      isAdmin: user.admin,
      tokenId: authResult.tokenId,
    },
    captureBody: user.admin,
  });

  if (!user.admin) {
    return { ok: false, status: 403, message: "You must be an admin to perform this action" };
  }

  return { ok: true, user };
}

/**
 * Remix loader/action wrapper around `authenticateAdminRequest` that throws
 * a Response on failure so routes can `await` without handling the error
 * branch. Uses `new Response` directly to avoid coupling this module to
 * `@remix-run/server-runtime`.
 */
export async function requireAdminApiRequest(request: Request): Promise<User> {
  const result = await authenticateAdminRequest(request);

  if (!result.ok) {
    throw new Response(JSON.stringify({ error: result.message, code: result.code }), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return result.user;
}

function getPersonalAccessTokenFromRequest(request: Request) {
  const rawAuthorization = request.headers.get("Authorization");

  const authorization = AuthorizationHeaderSchema.safeParse(rawAuthorization);
  if (!authorization.success) {
    return;
  }

  const personalAccessToken = authorization.data.replace(/^Bearer /, "");
  return personalAccessToken;
}

export async function authenticatePersonalAccessToken(
  token: string
): Promise<PersonalAccessTokenAuthenticationResult | undefined> {
  if (!token.startsWith(tokenPrefix)) {
    logger.warn(`PAT doesn't start with ${tokenPrefix}`);
    return;
  }

  const hashedToken = hashToken(token);

  const personalAccessToken = await prisma.personalAccessToken.findFirst({
    where: {
      hashedToken,
      revokedAt: null,
    },
  });

  if (!personalAccessToken) {
    // The token may have been revoked or is entirely invalid
    return;
  }

  // Checked before the lastAccessedAt write, so a request can't revive an idle-expired token.
  if (personalAccessTokenExpiry(personalAccessToken)) {
    return;
  }

  const lastUsedAt = await updateLastAccessedAtIfStale(
    personalAccessToken.id,
    personalAccessToken.lastAccessedAt
  );

  const decryptedToken = decryptPersonalAccessToken(personalAccessToken);

  if (decryptedToken !== token) {
    logger.error(
      `PersonalAccessToken with id: ${personalAccessToken.id} was found in the database with hash ${hashedToken}, but the decrypted token did not match the provided token.`
    );
    return;
  }

  return {
    userId: personalAccessToken.userId,
    tokenId: personalAccessToken.id,
    validUntil: personalAccessTokenValidUntil({
      ...personalAccessToken,
      lastAccessedAt: lastUsedAt,
    }),
  };
}

export function isPersonalAccessToken(token: string) {
  return token.startsWith(tokenPrefix);
}

/**
 * When the request's bearer is an unrevoked personal access token that has expired,
 * returns why and when. Lets a route that already rejected the request explain why.
 */
export async function getPersonalAccessTokenExpiry(
  request: Request
): Promise<PersonalAccessTokenExpiry | undefined> {
  const token = getPersonalAccessTokenFromRequest(request);
  if (!token || !isPersonalAccessToken(token)) {
    return;
  }

  const personalAccessToken = await $replica.personalAccessToken.findFirst({
    where: { hashedToken: hashToken(token), revokedAt: null },
    select: expiryColumns,
  });
  return personalAccessToken ? personalAccessTokenExpiry(personalAccessToken) : undefined;
}

/**
 * The 401 for a request whose personal access token didn't authenticate. If the token expired,
 * the body says when and where to make a new one; otherwise it carries `error`.
 */
export async function personalAccessTokenUnauthorizedResponse(
  request: Request,
  error = "Invalid or Missing Access Token"
): Promise<Response> {
  const expiry = await getPersonalAccessTokenExpiry(request);
  const body = expiry ? personalAccessTokenExpiryBody(expiry) : { error };
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A user-actor token minted from a PAT carries the source PAT's id (`claims.pat`).
 * The token is stateless, so revoking the PAT can't invalidate it by itself — hosts
 * recheck the source PAT is still live here. A token with no `pat` (e.g. the dashboard
 * agent's) has no source to check and is left alone.
 */
export async function assertSourcePatActive(claims: UserActorClaims): Promise<boolean> {
  if (!claims.pat) return true;

  const found = await prisma.personalAccessToken.findFirst({
    where: { id: claims.pat, revokedAt: null },
    select: expiryColumns,
  });
  return found !== null && !personalAccessTokenExpiry(found);
}

/**
 * Resolve + source-PAT-recheck a user-actor token for a verify site where `claims` may be
 * supplied by the RBAC plugin (the apiBuilder path). We re-verify the bearer locally so the
 * recheck reads the token's OWN `pat`, not the plugin's: a plugin image predating the `pat`
 * claim would deliver pat-less claims and silently no-op revocation here. Returns the claims
 * to act on, or undefined to deny. Locally-verified claims win whenever verification succeeds
 * — a plugin predating a claim would otherwise narrow the set the route builder scopes on —
 * and the plugin's claims are only the fallback.
 */
export async function resolveAndRecheckUserActorClaims(
  claims: UserActorClaims | undefined,
  bearer: string
): Promise<UserActorClaims | undefined> {
  const verified = await verifyUserActorToken(env.SESSION_SECRET, bearer);
  const resolved = verified ?? claims;
  if (!resolved) return undefined;
  return (await assertSourcePatActive(resolved)) ? resolved : undefined;
}

export const CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE =
  "This version of the Trigger.dev CLI can no longer log in. Upgrade to the latest version (npx trigger.dev@latest login) and try again.";

/** Whether codes minted without a PKCE challenge, by CLIs that predate it, are still honoured. */
export function isLegacyCliLoginAllowed(now = new Date()) {
  return now < new Date(env.CLI_LOGIN_LEGACY_UNTIL);
}

/** Uppercase without 0, 1, I and O, so an approval code survives being read and retyped. */
const approvalCodeGenerator = customAlphabet("23456789ABCDEFGHJKLMNPQRSTUVWXYZ", 12);

/** Formats an approval code for display as XXXX-XXXX-XXXX. */
function formatApprovalCode(approvalCode: string) {
  return approvalCode.match(/.{1,4}/g)!.join("-");
}

/** Accepts an approval code as typed or pasted: any case, with or without separators. */
function normalizeApprovalCode(approvalCode: string) {
  return approvalCode.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function codeChallengeFor(codeVerifier: string) {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Read-only lookup of an authorization code that is still mintable: it exists, is
 * unconsumed (`personalAccessTokenId: null`), and within the TTL. Lets the
 * consent-screen loader show Authorize vs expired/invalid without minting a PAT.
 * Returns null when the code can't be approved.
 */
export async function getMintableAuthorizationCode(
  authorizationCode: string,
  prismaClient = prisma
): Promise<{ legacy: boolean; createdAt: Date; requesterIp: string | null } | null> {
  const validAfter = new Date(Date.now() - AUTHORIZATION_CODE_TTL_MS);
  const code = await prismaClient.authorizationCode.findFirst({
    where: {
      code: authorizationCode,
      personalAccessTokenId: null,
      createdAt: { gte: validAfter },
    },
    select: { codeChallenge: true, createdAt: true, requesterIp: true },
  });

  if (!code) {
    return null;
  }

  const legacy = code.codeChallenge === null;
  if (legacy && !isLegacyCliLoginAllowed()) {
    return null;
  }

  return { legacy, createdAt: code.createdAt, requesterIp: code.requesterIp };
}

/**
 * The requester IP is shown on the consent page and in the authorized-login email, so a value
 * that isn't an IP address (a forged `X-Forwarded-For` on an install without a proxy) isn't stored.
 */
export function createAuthorizationCode(
  options: Partial<Pick<CreateAuthorizationCodeRequest, "codeChallenge" | "callbackPort">> & {
    requesterIp?: string | null;
  } = {}
) {
  const requesterIp = options.requesterIp?.trim();
  return prisma.authorizationCode.create({
    data: {
      code: nanoid(64),
      codeChallenge: options.codeChallenge,
      callbackPort: options.callbackPort,
      requesterIp: requesterIp && isIP(requesterIp) !== 0 ? requesterIp : undefined,
    },
  });
}

/** The approver is on a different network from the one that started the login and hasn't confirmed it. */
export class CliLoginNetworkConfirmationRequiredError extends Error {
  constructor() {
    super(
      "This login was started from a different network. Confirm you started it on another machine before authorizing it."
    );
    this.name = "CliLoginNetworkConfirmationRequiredError";
  }
}

/**
 * Mints a new PersonalAccessToken for an Auth Code. Every authorization gets its own token, so a
 * login never hands out a secret that another CLI or MCP client is already using.
 *
 * For a code minted with a PKCE challenge it also issues the approval code the client needs to
 * exchange the code. The caller hands it to the approving browser only: by redirect to the
 * client's loopback `callbackPort`, or on the page for the user to paste.
 *
 * Compares the approver's network with the one that minted the code. With
 * `CLI_LOGIN_NETWORK_CHECK=confirm` a login from another network needs `confirmedDifferentNetwork`;
 * with `log` only the outcome (never the addresses) is logged.
 */
export async function createPersonalAccessTokenFromAuthorizationCode(
  authorizationCode: string,
  userId: string,
  approval: { approverIp?: string | null; confirmedDifferentNetwork?: boolean } = {}
) {
  // Only allow authorization codes created within the short consent window.
  const validAfter = new Date(Date.now() - AUTHORIZATION_CODE_TTL_MS);
  const code = await prisma.authorizationCode.findFirst({
    where: {
      code: authorizationCode,
      personalAccessTokenId: null,
      createdAt: {
        gte: validAfter,
      },
    },
  });

  if (!code) {
    throw new Error("Invalid authorization code, code already used, or code expired");
  }

  if (!code.codeChallenge && !isLegacyCliLoginAllowed()) {
    throw new Error(CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE);
  }

  const approvalCode = code.codeChallenge ? approvalCodeGenerator() : undefined;

  const networkMatch = compareCliLoginNetworks(code.requesterIp, approval.approverIp);

  if (env.CLI_LOGIN_NETWORK_CHECK !== "off") {
    logger.info("CLI login network check", {
      networkMatch,
      mode: env.CLI_LOGIN_NETWORK_CHECK,
      confirmedDifferentNetwork: approval.confirmedDifferentNetwork === true,
    });
  }

  if (
    env.CLI_LOGIN_NETWORK_CHECK === "confirm" &&
    needsNetworkConfirmation(networkMatch) &&
    approval.confirmedDifferentNetwork !== true
  ) {
    throw new CliLoginNetworkConfirmationRequiredError();
  }

  const token = await createPersonalAccessToken({
    name: "cli",
    userId,
    auditSource: { ip: approval.approverIp ?? null, userAgent: null },
    idleTimeoutSeconds:
      env.CLI_LOGIN_IDLE_TIMEOUT_DAYS > 0
        ? env.CLI_LOGIN_IDLE_TIMEOUT_DAYS * SECONDS_PER_DAY
        : undefined,
  });

  const bound = await prisma.authorizationCode.updateMany({
    where: {
      id: code.id,
      personalAccessTokenId: null,
    },
    data: {
      personalAccessTokenId: token.id,
      approvalCodeHash: approvalCode ? hashToken(approvalCode) : undefined,
    },
  });

  if (bound.count === 0) {
    await revokePersonalAccessToken(token.id, userId);
    throw new Error("Invalid authorization code, code already used, or code expired");
  }

  return {
    ...token,
    requesterIp: code.requesterIp,
    networkMatch,
    approval: approvalCode
      ? { approvalCode: formatApprovalCode(approvalCode), callbackPort: code.callbackPort }
      : undefined,
  };
}

/** Deletes one page of authorization codes created before the cutoff. */
function deleteExpiredAuthorizationCodesPage(
  prismaClient: PrismaClientOrTransaction,
  cutoff: Date,
  batchSize: number
): Promise<number> {
  return prismaClient.$executeRaw`
    WITH page AS (
      SELECT id FROM "AuthorizationCode"
      WHERE "createdAt" < ${cutoff}
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "AuthorizationCode" a
    USING page WHERE a.id = page.id
  `;
}

/**
 * Deletes authorization codes past their TTL, which can no longer be approved or exchanged, so
 * abandoned logins don't keep their requester IP. Bounded per run so a large backlog drains over
 * several runs.
 */
export async function sweepExpiredAuthorizationCodes(
  prismaClient: PrismaClientOrTransaction = prisma,
  options: { batchSize?: number; maxPages?: number; now?: Date } = {}
): Promise<{ deleted: number; pages: number }> {
  const { batchSize = 1000, maxPages = 50, now = new Date() } = options;
  const cutoff = new Date(now.getTime() - AUTHORIZATION_CODE_TTL_MS);
  let deleted = 0;
  let pages = 0;

  while (pages < maxPages) {
    const count = await deleteExpiredAuthorizationCodesPage(prismaClient, cutoff, batchSize);
    pages++;
    deleted += count;
    if (count < batchSize) break;
  }

  if (deleted > 0) {
    logger.info("Deleted expired authorization codes", { deleted, pages });
  }

  return { deleted, pages };
}

/** Created a new PersonalAccessToken, and return the token. We only ever return the unencrypted token once. */
export async function createPersonalAccessToken({
  name,
  userId,
  roleId,
  auditSource,
  expiresAt,
  idleTimeoutSeconds,
}: CreatePersonalAccessTokenOptions) {
  const token = createToken();
  const encryptedToken = encryptToken(token, env.ENCRYPTION_KEYRING);

  const personalAccessToken = await prisma.personalAccessToken.create({
    data: {
      name,
      userId,
      encryptedToken,
      obfuscatedToken: obfuscateToken(token),
      hashedToken: hashToken(token),
      expiresAt,
      idleTimeoutSeconds,
    },
  });

  // Persist the role choice via the RBAC plugin's setTokenRole. The
  // plugin may store this in a separate datastore from Prisma (e.g.
  // Drizzle on a different schema), so co-transactional inserts are
  // awkward — we use a compensating-delete pattern instead: if
  // setTokenRole fails, roll back the PAT row by deleting it. The auth
  // path treats "no role" as permissive (matches the default fallback)
  // so a brief orphan window between the two writes is harmless. The
  // compensating delete narrows that window from "until manual cleanup"
  // to "until the request returns".
  //
  // Skip the call entirely when no RBAC plugin is loaded — the OSS
  // fallback has no TokenRole table to write to. Gating on
  // `rbac.isUsingPlugin()` (rather than parsing the fallback's error
  // string) keeps the OSS-vs-cloud branch explicit and decoupled from
  // any specific error message.
  if (roleId && (await rbac.isUsingPlugin())) {
    const roleResult = await rbac.setTokenRole({
      tokenId: personalAccessToken.id,
      roleId,
    });
    if (!roleResult.ok) {
      await prisma.personalAccessToken
        .delete({ where: { id: personalAccessToken.id } })
        .catch((err) => {
          logger.error("Failed to compensating-delete PAT after TokenRole insert failed", {
            patId: personalAccessToken.id,
            roleResultError: roleResult.error,
            deleteError: err instanceof Error ? err.message : String(err),
          });
        });
      throw new Error(`Failed to assign role to access token: ${roleResult.error}`);
    }
  } else if (roleId) {
    logger.debug("createPersonalAccessToken: no RBAC plugin, skipping role assignment", {
      patId: personalAccessToken.id,
      userId,
    });
  }

  void recordAdminPatCreated({
    userId,
    tokenId: personalAccessToken.id,
    name,
    source: auditSource,
  });

  return {
    id: personalAccessToken.id,
    name,
    userId,
    token,
    obfuscatedToken: personalAccessToken.obfuscatedToken,
    expiresAt: personalAccessToken.expiresAt,
  };
}

export type CreatedPersonalAccessToken = Awaited<ReturnType<typeof createPersonalAccessToken>>;

const tokenPrefix = "tr_pat_";

/** Creates a PersonalAccessToken that starts with tr_pat_  */
function createToken() {
  return `${tokenPrefix}${tokenGenerator()}`;
}

/** Obfuscates all but the first and last 4 characters of the token, so it looks like tr_pat_bhbd•••••••••••••••••••fd4a */
function obfuscateToken(token: string) {
  const withoutPrefix = token.replace(tokenPrefix, "");
  const obfuscated = `${withoutPrefix.slice(0, 4)}${"•".repeat(18)}${withoutPrefix.slice(-4)}`;
  return `${tokenPrefix}${obfuscated}`;
}

function decryptPersonalAccessToken(personalAccessToken: PersonalAccessToken) {
  const encryptedData = EncryptedSecretValueSchema.safeParse(personalAccessToken.encryptedToken);
  if (!encryptedData.success) {
    throw new Error(
      `Unable to parse encrypted PersonalAccessToken with id: ${personalAccessToken.id}: ${encryptedData.error.message}`
    );
  }

  const decryptedToken = decryptToken(encryptedData.data, env.ENCRYPTION_KEYRING);
  return decryptedToken;
}
