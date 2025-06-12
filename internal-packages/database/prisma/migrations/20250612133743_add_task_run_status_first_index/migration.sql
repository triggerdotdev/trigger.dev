
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TaskRun_status_runtimeEnvironmentId_createdAt_id_idx" ON "TaskRun"("status", "runtimeEnvironmentId", "createdAt", "id" DESC);
