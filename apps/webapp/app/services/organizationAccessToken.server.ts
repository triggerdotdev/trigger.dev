import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";
import { hashToken } from "~/utils/tokens.server";

// Skip the lastAccessedAt write if the existing value is already within this
// window. Eliminates per-auth UPDATE churn on a small narrow hot table; the
// settings UI reads this field at human granularity so a few-minute
// staleness is fine.
export const OAT_LAST_ACCESSED_THROTTLE_MS = 5 * 60 * 1000;

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

  // Conditional updateMany — only writes if the existing lastAccessedAt is
  // null or older than the throttle window. The WHERE runs inside the UPDATE
  // so concurrent auths don't race into a double-write. `revokedAt: null`
  // matches the findFirst guard above so a token revoked between the read
  // and write doesn't get a stale lastAccessedAt update.
  await prisma.organizationAccessToken.updateMany({
    where: {
      id: organizationAccessToken.id,
      revokedAt: null,
      OR: [
        { lastAccessedAt: null },
        { lastAccessedAt: { lt: new Date(Date.now() - OAT_LAST_ACCESSED_THROTTLE_MS) } },
      ],
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

const tokenPrefix = "tr_oat_";
