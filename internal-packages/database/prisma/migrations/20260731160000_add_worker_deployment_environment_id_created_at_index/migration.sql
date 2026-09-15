CREATE INDEX CONCURRENTLY IF NOT EXISTS "WorkerDeployment_environmentId_createdAt_idx" ON "public"."WorkerDeployment"("environmentId", "createdAt");
