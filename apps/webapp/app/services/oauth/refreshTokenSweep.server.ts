import type { PrismaClientOrTransaction } from "@trigger.dev/database";

const SWEEP_BATCH_SIZE = 1_000;

/** Deletes every refresh handle of dead grants: PAT revoked or expired, or newest handle idle-expired. */
export async function sweepOAuthRefreshTokens(
  prisma: PrismaClientOrTransaction,
  now: Date = new Date()
): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "OAuthRefreshToken"
    WHERE "personalAccessTokenId" IN (
      SELECT "personalAccessTokenId" FROM (
        SELECT r."personalAccessTokenId"
        FROM "OAuthRefreshToken" r
        WHERE r."idleExpiresAt" < ${now}
          AND NOT EXISTS (
            SELECT 1 FROM "OAuthRefreshToken" n
            WHERE n."personalAccessTokenId" = r."personalAccessTokenId"
              AND (n."createdAt", n.id) > (r."createdAt", r.id)
          )
        UNION
        SELECT p.id
        FROM "PersonalAccessToken" p
        WHERE p."oauthClientId" IS NOT NULL
          AND (p."revokedAt" IS NOT NULL OR p."expiresAt" < ${now})
          AND EXISTS (
            SELECT 1 FROM "OAuthRefreshToken" t WHERE t."personalAccessTokenId" = p.id
          )
      ) dead
      LIMIT ${SWEEP_BATCH_SIZE}
    )
  `;
}
