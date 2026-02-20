
-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "WorkerDeployment_commitSHA_idx" ON "public"."WorkerDeployment"("commitSHA");