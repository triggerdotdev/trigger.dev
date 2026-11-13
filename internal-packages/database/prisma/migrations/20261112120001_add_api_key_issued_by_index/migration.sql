-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "api_keys_env_issued_by_revoked_at_created_at_idx" ON "public"."api_keys"("runtime_environment_id", "issued_by", "revoked_at", "created_at" DESC);
