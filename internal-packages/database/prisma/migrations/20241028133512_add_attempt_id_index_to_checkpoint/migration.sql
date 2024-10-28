-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Checkpoint_attemptId_idx" ON "Checkpoint"("attemptId");