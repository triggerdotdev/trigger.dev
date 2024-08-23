-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_jobrun_organizationId_createdAt" ON "JobRun" ("organizationId", "createdAt");