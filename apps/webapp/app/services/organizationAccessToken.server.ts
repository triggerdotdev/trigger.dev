import { type OrganizationAccessToken } from "@trigger.dev/database";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";
import { decryptToken, encryptToken, hashToken } from "~/utils/tokens.server";
import { env } from "~/env.server";

const tokenValueLength = 40;
//lowercase only, removed 0 and l to avoid confusion
const tokenGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", tokenValueLength);

type CreateOrganizationAccessTokenOptions = {
  name: string;
  organizationId: string;
  expiresAt?: Date;
};

export async function getValidOrganizationAccessTokens(organizationId: string) {
  const organizationAccessTokens = await prisma.organizationAccessToken.findMany({
    select: {
      id: true,
      name: true,
      obfuscatedToken: true,
      createdAt: true,
      lastAccessedAt: true,
      expiresAt: true,
    },
    where: {
      organizationId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }],
    },
  });

  return organizationAccessTokens.map((oat) => ({
    id: oat.id,
    name: oat.name,
    obfuscatedToken: oat.obfuscatedToken,
    createdAt: oat.createdAt,
    lastAccessedAt: oat.lastAccessedAt,
    expiresAt: oat.expiresAt,
  }));
}

export type ObfuscatedOrganizationAccessToken = Awaited<
  ReturnType<typeof getValidOrganizationAccessTokens>
>[number];

export async function revokeOrganizationAccessToken(tokenId: string) {
  await prisma.organizationAccessToken.update({
    where: {
      id: tokenId,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

export type OrganizationAccessTokenAuthenticationResult = {
  organizationId: string;
};

const EncryptedSecretValueSchema = z.object({
  nonce: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});

const AuthorizationHeaderSchema = z.string().regex(/^Bearer .+$/);

export async function authenticateApiRequestWithOrganizationAccessToken(
  request: Request
): Promise<OrganizationAccessTokenAuthenticationResult | undefined> {
  const token = getOrganizationAccessTokenFromRequest(request);
  if (!token) {
    return;
  }

  return authenticateOrganizationAccessToken(token);
}

function getOrganizationAccessTokenFromRequest(request: Request) {
  const rawAuthorization = request.headers.get("Authorization");

  const authorization = AuthorizationHeaderSchema.safeParse(rawAuthorization);
  if (!authorization.success) {
    return;
  }

  const organizationAccessToken = authorization.data.replace(/^Bearer /, "");
  return organizationAccessToken;
}

export async function authenticateOrganizationAccessToken(
  token: string
): Promise<OrganizationAccessTokenAuthenticationResult | undefined> {
  if (!token.startsWith(tokenPrefix)) {
    logger.warn(`OAT doesn't start with ${tokenPrefix}`);
    return;
  }

  const hashedToken = hashToken(token);

  const organizationAccessToken = await prisma.organizationAccessToken.findFirst({
    where: {
      hashedToken,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }],
    },
  });

  if (!organizationAccessToken) {
    return;
  }

  await prisma.organizationAccessToken.update({
    where: {
      id: organizationAccessToken.id,
    },
    data: {
      lastAccessedAt: new Date(),
    },
  });

  const decryptedToken = decryptOrganizationAccessToken(organizationAccessToken);

  if (decryptedToken !== token) {
    logger.error(
      `OrganizationAccessToken with id: ${organizationAccessToken.id} was found in the database with hash ${hashedToken}, but the decrypted token did not match the provided token.`
    );
    return;
  }

  return {
    organizationId: organizationAccessToken.organizationId,
  };
}

export function isOrganizationAccessToken(token: string) {
  return token.startsWith(tokenPrefix);
}

export async function createOrganizationAccessToken({
  name,
  organizationId,
  expiresAt,
}: CreateOrganizationAccessTokenOptions) {
  const token = createToken();
  const encryptedToken = encryptToken(token, env.ENCRYPTION_KEY);

  const organizationAccessToken = await prisma.organizationAccessToken.create({
    data: {
      name,
      organizationId,
      encryptedToken,
      obfuscatedToken: obfuscateToken(token),
      hashedToken: hashToken(token),
      expiresAt,
    },
  });

  return {
    id: organizationAccessToken.id,
    name,
    organizationId,
    token,
    obfuscatedToken: organizationAccessToken.obfuscatedToken,
    expiresAt: organizationAccessToken.expiresAt,
  };
}

export type CreatedOrganizationAccessToken = Awaited<
  ReturnType<typeof createOrganizationAccessToken>
>;

const tokenPrefix = "tr_oat_";

function createToken() {
  return `${tokenPrefix}${tokenGenerator()}`;
}

function obfuscateToken(token: string) {
  const withoutPrefix = token.replace(tokenPrefix, "");
  const obfuscated = `${withoutPrefix.slice(0, 4)}${"•".repeat(18)}${withoutPrefix.slice(-4)}`;
  return `${tokenPrefix}${obfuscated}`;
}

function decryptOrganizationAccessToken(organizationAccessToken: OrganizationAccessToken) {
  const encryptedData = EncryptedSecretValueSchema.safeParse(
    organizationAccessToken.encryptedToken
  );
  if (!encryptedData.success) {
    throw new Error(
      `Unable to parse encrypted OrganizationAccessToken with id: ${organizationAccessToken.id}: ${encryptedData.error.message}`
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
