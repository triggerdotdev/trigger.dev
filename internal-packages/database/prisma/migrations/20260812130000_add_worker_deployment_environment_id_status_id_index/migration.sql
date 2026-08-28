CREATE INDEX CONCURRENTLY IF NOT EXISTS "WorkerDeployment_environmentId_status_id_idx" ON "public"."WorkerDeployment"("environmentId", "status", "id");
