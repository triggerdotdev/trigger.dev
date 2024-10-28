-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Checkpoint_runId_idx" ON "Checkpoint"("runId");