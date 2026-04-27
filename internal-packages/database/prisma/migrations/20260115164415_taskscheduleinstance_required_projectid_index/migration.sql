-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TaskScheduleInstance_projectId_active_idx" ON "public"."TaskScheduleInstance" ("projectId", "active");