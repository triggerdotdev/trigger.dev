-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TaskRun_runtimeEnvironmentId_createdAt_id_idx" ON "TaskRun"("runtimeEnvironmentId", "createdAt" DESC, "id" DESC);
