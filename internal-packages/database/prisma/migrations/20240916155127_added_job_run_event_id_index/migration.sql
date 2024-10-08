-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "JobRun_eventId_idx" ON "JobRun" ("eventId");