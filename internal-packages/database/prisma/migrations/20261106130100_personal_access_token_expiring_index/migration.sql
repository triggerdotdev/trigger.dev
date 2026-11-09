-- CreateIndex (SQL-only: Prisma can't express partial indexes). The expiry reminder job's scan:
-- unrevoked tokens that have an expiry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "PersonalAccessToken_expiresAt_unrevoked_idx" ON "PersonalAccessToken"("expiresAt") WHERE "expiresAt" IS NOT NULL AND "revokedAt" IS NULL;
