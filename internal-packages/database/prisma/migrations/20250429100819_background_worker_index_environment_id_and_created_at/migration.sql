-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "BackgroundWorker_runtimeEnvironmentId_createdAt_idx" ON "BackgroundWorker" ("runtimeEnvironmentId", "createdAt" DESC);