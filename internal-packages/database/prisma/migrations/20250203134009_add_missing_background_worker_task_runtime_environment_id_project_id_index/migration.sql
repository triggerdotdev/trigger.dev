-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "BackgroundWorkerTask_runtimeEnvironmentId_projectId_idx" ON "BackgroundWorkerTask"("runtimeEnvironmentId", "projectId");