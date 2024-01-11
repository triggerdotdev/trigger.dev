import { nanoid } from "nanoid";
import nodeCrypto from "node:crypto";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "./logger.server";

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

export async function revokePersonalAccessToken(tokenId: string) {
  await prisma.personalAccessToken.update({
    where: {
      id: tokenId,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

type PersonalAccessTokenAuthenticationResult = {
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
    return;
  }

  const hashedToken = hashToken(token);

  const personalAccessToken = await prisma.personalAccessToken.update({
    where: {
      hashedToken,
      revokedAt: null,
    },
    data: {
      lastAccessedAt: new Date(),
    },
  });

  if (!personalAccessToken) {
    return;
  }

  const encryptedData = EncryptedSecretValueSchema.safeParse(personalAccessToken.encryptedToken);

  if (!encryptedData.success) {
    throw new Error(
      `Unable to parse encrypted PersonalAccessToken with id: ${personalAccessToken.id}: ${encryptedData.error.message}`
    );
  }

  const decryptedToken = decryptToken(
    encryptedData.data.nonce,
    encryptedData.data.ciphertext,
    encryptedData.data.tag
  );

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
  const code = await prisma.authorizationCode.findUnique({
    where: {
      code: authorizationCode,
      personalAccessTokenId: null,
    },
  });

  if (!code) {
    throw new Error("Invalid authorization code, or code already used");
  }

  const existingCliPersonalAccessToken = await prisma.personalAccessToken.findFirst({
    where: {
      userId,
      name: "cli",
    },
  });

  //we only allow you to have one CLI PAT at a time
  if (existingCliPersonalAccessToken) {
    await prisma.personalAccessToken.delete({
      where: {
        id: existingCliPersonalAccessToken.id,
      },
    });
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
  const encryptedToken = encryptToken(token);

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
const tokenValueLength = 64;

/** Creates a PersonalAccessToken that starts with tr_pat_  */
function createToken() {
  return `${tokenPrefix}${nanoid(tokenValueLength)}`;
}

/** Obfuscates all but the first and last 4 characters of the token, so it looks like tr_pat_bhbd•••••••••••••••••••fd4a */
function obfuscateToken(token: string) {
  const withoutPrefix = token.replace(tokenPrefix, "");
  const obfuscated = `${withoutPrefix.slice(0, 4)}${"●".repeat(18)}${withoutPrefix.slice(-4)}`;
  return `${tokenPrefix}${obfuscated}`;
}

function encryptToken(value: string) {
  const nonce = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", env.ENCRYPTION_KEY, nonce);

  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");

  const tag = cipher.getAuthTag().toString("hex");

  return {
    nonce: nonce.toString("hex"),
    ciphertext: encrypted,
    tag,
  };
}

function decryptToken(nonce: string, ciphertext: string, tag: string): string {
  const decipher = nodeCrypto.createDecipheriv(
    "aes-256-gcm",
    env.ENCRYPTION_KEY,
    Buffer.from(nonce, "hex")
  );

  decipher.setAuthTag(Buffer.from(tag, "hex"));

  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

function hashToken(token: string): string {
  const hash = nodeCrypto.createHash("sha256");
  hash.update(token);
  return hash.digest("hex");
}
