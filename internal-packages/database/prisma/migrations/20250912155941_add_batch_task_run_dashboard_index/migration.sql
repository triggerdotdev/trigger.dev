-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "BatchTaskRun_runtimeEnvironmentId_id_idx" ON "public"."BatchTaskRun"("runtimeEnvironmentId", "id" DESC);