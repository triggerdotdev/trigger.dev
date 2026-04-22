CREATE INDEX CONCURRENTLY IF NOT EXISTS "BackgroundWorkerTask_runtimeEnvironmentId_slug_triggerSource_idx"
  ON "BackgroundWorkerTask"("runtimeEnvironmentId", slug, "triggerSource");
