-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TaskRun_projectId_id_idx" ON "TaskRun"("projectId", "id" DESC);
