-- CreateIndex
CREATE INDEX CONCURRENTLY "EventSubscription_projectId_environmentId_enabled_idx" ON "public"."EventSubscription"("projectId", "environmentId", "enabled");
