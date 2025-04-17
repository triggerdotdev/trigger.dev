-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TaskSchedule_projectId_idx" ON "TaskSchedule" ("projectId");

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TaskSchedule_projectId_createdAt_idx" ON "TaskSchedule" ("projectId", "createdAt" DESC);