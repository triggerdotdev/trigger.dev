-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "BatchTaskRun_dependentTaskAttemptId_idx" ON "BatchTaskRun"("dependentTaskAttemptId");