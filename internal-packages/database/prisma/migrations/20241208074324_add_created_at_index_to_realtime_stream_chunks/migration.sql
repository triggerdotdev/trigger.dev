-- CreateIndex
CREATE INDEX "RealtimeStreamChunk_createdAt_idx" ON "RealtimeStreamChunk"("createdAt");

-- RenameIndex
ALTER INDEX "RealtimeStreamChunk_runId" RENAME TO "RealtimeStreamChunk_runId_idx";
