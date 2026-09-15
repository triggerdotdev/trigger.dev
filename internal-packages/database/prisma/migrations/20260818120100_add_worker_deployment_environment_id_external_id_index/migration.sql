CREATE INDEX CONCURRENTLY IF NOT EXISTS "WorkerDeployment_environmentId_externalId_idx" ON "public"."WorkerDeployment"("environmentId", "externalId");
