import { type PersonalAccessToken, type User } from "@trigger.dev/database";
import { customAlphabet, nanoid } from "nanoid";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";
import { rbac } from "./rbac.server";
import { decryptToken, encryptToken, hashToken } from "~/utils/tokens.server";
import { env } from "~/env.server";

const tokenValueLength = 40;
//lowercase only, removed 0 and l to avoid confusion
const tokenGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", tokenValueLength);

// Skip the lastAccessedAt write if the existing value is already within this
// window. Eliminates per-auth UPDATE churn on a small narrow hot table; the
// /account/tokens UI reads this field at human granularity so a few-minute
// staleness is fine.
export const PAT_LAST_ACCESSED_THROTTLE_MS = 5 * 60 * 1000;

// The OSS fallback's setTokenRole returns this exact string when no
// enterprise plugin is loaded. We treat that as "no role attached" —
// the PAT is still valid; auth just falls through to legacy permissive
// behaviour. Any other error is treated as a real failure and triggers
// the compensating delete below.
const FALLBACK_NOT_INSTALLED_ERROR = "RBAC fallback not installed";

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

/** Gets a PersonalAccessToken from an Auth Code, this only works within 10 mins of the auth code being created */
export async function getPersonalAccessTokenFromAuthorizationCode(authorizationCode: string) {
  //only allow authorization codes that were created less than 10 mins ago
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const code = await prisma.authorizationCode.findUnique({
    select: {
      personalAccessToken: true,
    },
    where: {
      code: authorizationCode,
      createdAt: {
        gte: tenMinutesAgo,
      },
    },
  });
  if (!code) {
    throw new Error("Invalid authorization code, or code expired");
  }

  //there's no PersonalAccessToken associated with this code
  if (!code.personalAccessToken) {
    return {
      token: null,
    };
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
};

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

  // Conditional updateMany — only writes if the existing lastAccessedAt is
  // null or older than the throttle window. The WHERE runs inside the UPDATE
  // so concurrent auths don't race into a double-write. `revokedAt: null`
  // matches the findFirst guard above so a token revoked between the read
  // and write doesn't get a stale lastAccessedAt update.
  await prisma.personalAccessToken.updateMany({
    where: {
      id: personalAccessToken.id,
      revokedAt: null,
      OR: [
        { lastAccessedAt: null },
        { lastAccessedAt: { lt: new Date(Date.now() - PAT_LAST_ACCESSED_THROTTLE_MS) } },
      ],
    },
    data: {
      lastAccessedAt: new Date(),
    },
  });

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

export function createAuthorizationCode() {
  return prisma.authorizationCode.create({
    data: {
      code: nanoid(64),
    },
  });
}

/** Creates a PersonalAccessToken from an Auth Code, and return the token. We only ever return the unencrypted token once. */
export async function createPersonalAccessTokenFromAuthorizationCode(
  authorizationCode: string,
  userId: string
) {
  //only allow authorization codes that were created less than 10 mins ago
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const code = await prisma.authorizationCode.findUnique({
    where: {
      code: authorizationCode,
      personalAccessTokenId: null,
      createdAt: {
        gte: tenMinutesAgo,
      },
    },
  });

  if (!code) {
    throw new Error("Invalid authorization code, code already used, or code expired");
  }

  const existingCliPersonalAccessToken = await prisma.personalAccessToken.findFirst({
    where: {
      userId,
      name: "cli",
    },
  });

  //we only allow you to have one CLI PAT at a time, so return this
  if (existingCliPersonalAccessToken) {
    //associate this authorization code with the existing personal access token
    await prisma.authorizationCode.update({
      where: {
        code: authorizationCode,
      },
      data: {
        personalAccessTokenId: existingCliPersonalAccessToken.id,
      },
    });

    if (existingCliPersonalAccessToken.revokedAt) {
      // re-activate revoked CLI PAT so we can use it again
      await prisma.personalAccessToken.update({
        where: {
          id: existingCliPersonalAccessToken.id,
        },
        data: {
          revokedAt: null,
        },
      });
    }

    //we don't return the decrypted token
    return {
      id: existingCliPersonalAccessToken.id,
      name: existingCliPersonalAccessToken.name,
      userId: existingCliPersonalAccessToken.userId,
      obfuscateToken: existingCliPersonalAccessToken.obfuscatedToken,
    };
  }

  const token = await createPersonalAccessToken({
    name: "cli",
    userId,
  });

  await prisma.authorizationCode.update({
    where: {
      code: authorizationCode,
    },
    data: {
      personalAccessTokenId: token.id,
    },
  });

  return token;
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
  if (roleId) {
    const roleResult = await rbac.setTokenRole({
      tokenId: personalAccessToken.id,
      roleId,
    });
    if (!roleResult.ok) {
      // The default fallback always returns ok=false with this exact
      // message. That isn't a failure — there's no plugin to write to,
      // so the PAT just runs without an explicit role (matches the
      // pre-RBAC behaviour). Don't compensating-delete in that case.
      if (roleResult.error === FALLBACK_NOT_INSTALLED_ERROR) {
        logger.debug("createPersonalAccessToken: no RBAC plugin, skipping role assignment", {
          patId: personalAccessToken.id,
          userId,
        });
      } else {
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
    }
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
