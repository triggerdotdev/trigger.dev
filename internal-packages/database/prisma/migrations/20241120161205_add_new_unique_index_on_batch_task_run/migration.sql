-- CreateIndex
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "BatchTaskRun_runtimeEnvironmentId_idempotencyKey_key" ON "BatchTaskRun"("runtimeEnvironmentId", "idempotencyKey");