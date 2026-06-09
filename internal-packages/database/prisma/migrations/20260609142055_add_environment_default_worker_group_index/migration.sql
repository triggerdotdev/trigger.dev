-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "RuntimeEnvironment_defaultWorkerGroupId_idx"
  ON "public"."RuntimeEnvironment"("defaultWorkerGroupId");
