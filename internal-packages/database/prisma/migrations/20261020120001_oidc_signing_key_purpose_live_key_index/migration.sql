-- CreateIndex (SQL-only: Prisma can't express partial indexes). At most one STAGED and one ACTIVE key per purpose.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "OidcSigningKey_purpose_status_live_key" ON "OidcSigningKey"("purpose", "status") WHERE "status" IN ('STAGED', 'ACTIVE');
