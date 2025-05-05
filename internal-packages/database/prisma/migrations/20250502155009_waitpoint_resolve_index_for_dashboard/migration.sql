-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Waitpoint_environmentId_resolver_createdAt_idx" ON "Waitpoint" ("environmentId", "resolver", "createdAt" DESC);