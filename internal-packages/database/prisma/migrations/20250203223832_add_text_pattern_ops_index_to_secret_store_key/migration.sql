-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SecretStore_key_idx" ON "SecretStore"("key" text_pattern_ops);