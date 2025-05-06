-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Waitpoint_environmentId_resolver_status_id_idx" ON "Waitpoint" ("environmentId", "resolver", "status", "id" DESC);