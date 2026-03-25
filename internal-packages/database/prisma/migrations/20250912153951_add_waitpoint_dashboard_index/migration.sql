-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Waitpoint_environmentId_type_id_idx" ON "public"."Waitpoint"("environmentId", "type", "id" DESC);
