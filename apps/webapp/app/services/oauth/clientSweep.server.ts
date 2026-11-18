import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { tryCatch } from "@trigger.dev/core";

const SWEEP_BATCH_SIZE = 1_000;
const DELETE_CHUNK_SIZE = 100;
const DCR_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Catches: PersonalAccessToken.oauthClientId is ON DELETE RESTRICT, so any grant PAT, live or dead, keeps its client.
export async function sweepOAuthClients(
  prisma: PrismaClientOrTransaction,
  now: Date = new Date()
): Promise<{ deleted: number; failedChunks: number }> {
  const candidates = await prisma.$queryRaw<{ id: string }[]>`
    SELECT c.id
    FROM "OAuthClient" c
    WHERE c.kind = 'DCR'
      AND COALESCE(c."metadataExpiresAt", c."updatedAt" + ${DCR_TTL_MS}::bigint * interval '1 millisecond') < ${now}
      AND NOT EXISTS (SELECT 1 FROM "PersonalAccessToken" p WHERE p."oauthClientId" = c.id)
      AND NOT EXISTS (SELECT 1 FROM "OAuthRefreshToken" r WHERE r."oauthClientId" = c.id)
      AND NOT EXISTS (SELECT 1 FROM "AuthorizationCode" a WHERE a."oauthClientId" = c.id)
    LIMIT ${SWEEP_BATCH_SIZE}
  `;

  let deleted = 0;
  let failedChunks = 0;
  for (let i = 0; i < candidates.length; i += DELETE_CHUNK_SIZE) {
    const ids = candidates.slice(i, i + DELETE_CHUNK_SIZE).map((c) => c.id);
    const [error, count] = await tryCatch(
      prisma.$executeRaw`
        DELETE FROM "OAuthClient" c
        WHERE c.id = ANY(${ids})
          AND COALESCE(c."metadataExpiresAt", c."updatedAt" + ${DCR_TTL_MS}::bigint * interval '1 millisecond') < ${now}
          AND NOT EXISTS (SELECT 1 FROM "PersonalAccessToken" p WHERE p."oauthClientId" = c.id)
          AND NOT EXISTS (SELECT 1 FROM "OAuthRefreshToken" r WHERE r."oauthClientId" = c.id)
          AND NOT EXISTS (SELECT 1 FROM "AuthorizationCode" a WHERE a."oauthClientId" = c.id)`
    );
    if (error) failedChunks++;
    else deleted += count;
  }
  return { deleted, failedChunks };
}
