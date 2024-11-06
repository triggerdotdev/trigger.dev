-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TaskRun_scheduleId_createdAt_idx" ON "TaskRun"("scheduleId", "createdAt" DESC);
