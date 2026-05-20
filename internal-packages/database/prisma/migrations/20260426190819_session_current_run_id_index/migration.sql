-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Session_currentRunId_idx"
    ON "Session"("currentRunId");
