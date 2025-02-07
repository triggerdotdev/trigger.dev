-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CheckpointRestoreEvent_checkpointId_idx" ON "CheckpointRestoreEvent"("checkpointId");