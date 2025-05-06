-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Waitpoint_environmentId_resolver_id_idx" ON "Waitpoint" ("environmentId", "resolver", "id" DESC);