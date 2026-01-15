-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TaskScheduleInstance_environmentId_idx" ON "public"."TaskScheduleInstance" ("environmentId");