-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CheckpointRestoreEvent_runId_idx" ON "CheckpointRestoreEvent"("runId");