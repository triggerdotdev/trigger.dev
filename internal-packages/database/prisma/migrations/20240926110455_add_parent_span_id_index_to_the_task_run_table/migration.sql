-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TaskRun_parentSpanId_idx" ON "TaskRun"("parentSpanId");
