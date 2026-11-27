-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "BulkActionItem_groupId_createdAt_idx" ON "BulkActionItem"("groupId", "createdAt");
