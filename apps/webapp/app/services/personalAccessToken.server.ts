import {
  type PersonalAccessToken,
  type PrismaClientOrTransaction,
  type User,
} from "@trigger.dev/database";
import { compareCliLoginNetworks, needsNetworkConfirmation } from "./cliLoginNetwork.server";
import { customAlphabet, nanoid } from "nanoid";
import { isIP } from "node:net";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";
import { rbac } from "./rbac.server";
import { decryptToken, encryptToken, hashToken } from "~/utils/tokens.server";
import { env } from "~/env.server";
import { isUserActorToken, verifyUserActorToken, type UserActorClaims } from "@trigger.dev/rbac";

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

type CreatePersonalAccessTokenOptions = {
  name: string;
  userId: string;
  // Optional: when provided, persist a TokenRole row alongside the PAT
  // so PAT-authenticated requests pick up that role's permissions
  // (TRI-8749). The dashboard tokens page passes a chosen system role;
  // the CLI auth-code path doesn't pass one (legacy behaviour
  // preserved — those PATs run with no explicit role).
  roleId?: string;
};

/** Returns obfuscated access tokens that aren't revoked */
export async function getValidPersonalAccessTokens(userId: string) {
  const personalAccessTokens = await prisma.personalAccessToken.findMany({
    select: {
      id: true,
      name: true,
      obfuscatedToken: true,
      createdAt: true,
      lastAccessedAt: true,
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
  }));
}

export type ObfuscatedPersonalAccessToken = Awaited<
  ReturnType<typeof getValidPersonalAccessTokens>
>[number];

/**
 * Gets a PersonalAccessToken from an Auth Code, this only works within 10 mins of the auth code being created.
 * Codes are single use: the request that discloses the token also deletes the code.
 */
export async function getPersonalAccessTokenFromAuthorizationCode(authorizationCode: string) {
  // Only allow authorization codes created within the short consent window.
  const validAfter = new Date(Date.now() - AUTHORIZATION_CODE_TTL_MS);
  const code = await prisma.authorizationCode.findFirst({
    select: {
      id: true,
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

  //there's no PersonalAccessToken associated with this code
  if (!code.personalAccessToken) {
    return {
      token: null,
    };
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
  /**
   * Verified claims when the caller presented a delegated user-actor token. They ride on the
   * result so no caller can hold the actor without its environment scope.
   */
  userActor?: UserActorClaims;
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
 */
export async function updateLastAccessedAtIfStale(
  tokenId: string,
  lastAccessedAt: Date | null
): Promise<void> {
  if (lastAccessedAt && Date.now() - lastAccessedAt.getTime() <= PAT_LAST_ACCESSED_THROTTLE_MS) {
    return; // fresh — no roundtrip
  }
  await prisma.personalAccessToken.updateMany({
    where: {
      id: tokenId,
      revokedAt: null,
      OR: [
        { lastAccessedAt: null },
        { lastAccessedAt: { lt: new Date(Date.now() - PAT_LAST_ACCESSED_THROTTLE_MS) } },
      ],
    },
    data: { lastAccessedAt: new Date() },
  });
}

const EncryptedSecretValueSchema = z.object({
  nonce: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});

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
  | { ok: false; status: 401 | 403; message: string };

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
    return { ok: false, status: 401, message: "Invalid or Missing API key" };
  }

  const user = await prisma.user.findFirst({
    where: { id: authResult.userId },
  });

  if (!user) {
    return { ok: false, status: 401, message: "Invalid or Missing API key" };
  }

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
    throw new Response(JSON.stringify({ error: result.message }), {
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

  await updateLastAccessedAtIfStale(personalAccessToken.id, personalAccessToken.lastAccessedAt);

  const decryptedToken = decryptPersonalAccessToken(personalAccessToken);

  if (decryptedToken !== token) {
    logger.error(
      `PersonalAccessToken with id: ${personalAccessToken.id} was found in the database with hash ${hashedToken}, but the decrypted token did not match the provided token.`
    );
    return;
  }

  return {
    userId: personalAccessToken.userId,
  };
}

export function isPersonalAccessToken(token: string) {
  return token.startsWith(tokenPrefix);
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
    select: { id: true },
  });
  return Boolean(found);
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

/**
 * Read-only lookup of an authorization code that is still mintable: it exists, is
 * unconsumed (`personalAccessTokenId: null`), and within the TTL. Lets the
 * consent-screen loader show Authorize vs expired/invalid without minting a PAT.
 * Returns null when the code can't be approved.
 */
export async function getMintableAuthorizationCode(
  authorizationCode: string,
  prismaClient = prisma
): Promise<{ createdAt: Date; requesterIp: string | null } | null> {
  const validAfter = new Date(Date.now() - AUTHORIZATION_CODE_TTL_MS);
  return prismaClient.authorizationCode.findFirst({
    where: {
      code: authorizationCode,
      personalAccessTokenId: null,
      createdAt: { gte: validAfter },
    },
    select: { createdAt: true, requesterIp: true },
  });
}

/**
 * The requester IP is shown on the consent page and in the authorized-login email, so a value
 * that isn't an IP address (a forged `X-Forwarded-For` on an install without a proxy) isn't stored.
 */
export function createAuthorizationCode(requester?: { requesterIp?: string | null }) {
  const requesterIp = requester?.requesterIp?.trim();
  return prisma.authorizationCode.create({
    data: {
      code: nanoid(64),
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
  });

  const bound = await prisma.authorizationCode.updateMany({
    where: {
      id: code.id,
      personalAccessTokenId: null,
    },
    data: {
      personalAccessTokenId: token.id,
    },
  });

  if (bound.count === 0) {
    await revokePersonalAccessToken(token.id, userId);
    throw new Error("Invalid authorization code, code already used, or code expired");
  }

  return { ...token, requesterIp: code.requesterIp, networkMatch };
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
}: CreatePersonalAccessTokenOptions) {
  const token = createToken();
  const encryptedToken = encryptToken(token, env.ENCRYPTION_KEY);

  const personalAccessToken = await prisma.personalAccessToken.create({
    data: {
      name,
      userId,
      encryptedToken,
      obfuscatedToken: obfuscateToken(token),
      hashedToken: hashToken(token),
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

  return {
    id: personalAccessToken.id,
    name,
    userId,
    token,
    obfuscatedToken: personalAccessToken.obfuscatedToken,
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

  const decryptedToken = decryptToken(
    encryptedData.data.nonce,
    encryptedData.data.ciphertext,
    encryptedData.data.tag,
    env.ENCRYPTION_KEY
  );
  return decryptedToken;
}
