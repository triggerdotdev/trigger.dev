CREATE INDEX CONCURRENTLY IF NOT EXISTS "TaskRun_createdAt_idx" ON "TaskRun" USING BRIN ("createdAt");
