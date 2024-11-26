-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TaskRun_runtimeEnvironmentId_batchId_idx" ON "TaskRun"("runtimeEnvironmentId", "batchId");