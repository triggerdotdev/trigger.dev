-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Waitpoint_environmentId_resolver_status_createdAt_idx" ON "Waitpoint" (
  "environmentId",
  "resolver",
  "status",
  "createdAt" DESC
);