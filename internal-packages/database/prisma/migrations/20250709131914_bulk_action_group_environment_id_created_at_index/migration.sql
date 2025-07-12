-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "BulkActionGroup_environmentId_createdAt_idx" ON "BulkActionGroup" ("environmentId", "createdAt" DESC);