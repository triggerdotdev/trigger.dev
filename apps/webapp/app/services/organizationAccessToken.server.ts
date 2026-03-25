import { customAlphabet } from "nanoid";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";
import { hashToken } from "~/utils/tokens.server";

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

  const organizationAccessToken = await prisma.organizationAccessToken.create({
    data: {
      name,
      organizationId,
      hashedToken: hashToken(token),
      expiresAt,
    },
  });

  return {
    id: organizationAccessToken.id,
    name,
    organizationId,
    token,
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
