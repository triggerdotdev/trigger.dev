-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "BatchTaskRun_runtimeEnvironmentId_createdAt_id_idx" ON "public"."BatchTaskRun"("runtimeEnvironmentId", "createdAt" DESC, "id" DESC);
