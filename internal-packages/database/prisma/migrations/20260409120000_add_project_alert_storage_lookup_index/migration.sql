-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ProjectAlertStorage_alertChannelId_alertType_storageId_idx" ON "ProjectAlertStorage"("alertChannelId", "alertType", "storageId");
