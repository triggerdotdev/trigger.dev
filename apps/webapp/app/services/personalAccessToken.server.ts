import { type PersonalAccessToken, type User } from "@trigger.dev/database";
import { customAlphabet, nanoid } from "nanoid";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";
import { decryptToken, encryptToken, hashToken } from "~/utils/tokens.server";
import { env } from "~/env.server";

const tokenValueLength = 40;
//lowercase only, removed 0 and l to avoid confusion
const tokenGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", tokenValueLength);

type CreatePersonalAccessTokenOptions = {
  name: string;
  userId: string;
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

  // Touch lastAccessedAt with updateMany rather than update so a missing
  // row (e.g. the PAT was cascade-deleted by a concurrent User delete
  // between the findFirst above and this call) yields count = 0 instead
  // of throwing. count = 0 means the token no longer exists — treat that
  // as an authentication miss rather than handing a userId for a deleted
  // user back to callers that don't re-verify the user.
  const touchResult = await prisma.personalAccessToken.updateMany({
    where: { id: personalAccessToken.id },
    data: { lastAccessedAt: new Date() },
  });

  if (touchResult.count === 0) {
    logger.warn("PersonalAccessToken vanished between findFirst and update", {
      personalAccessTokenId: personalAccessToken.id,
    });
    return;
  }

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
