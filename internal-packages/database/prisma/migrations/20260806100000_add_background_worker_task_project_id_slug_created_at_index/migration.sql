CREATE INDEX CONCURRENTLY IF NOT EXISTS "BackgroundWorkerTask_projectId_slug_createdAt_idx" ON "public"."BackgroundWorkerTask"("projectId", "slug", "createdAt");
