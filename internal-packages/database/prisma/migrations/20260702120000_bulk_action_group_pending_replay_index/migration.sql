-- Backs the per-environment concurrent-replay limit: count of PENDING REPLAY groups.
-- Not partial (e.g. WHERE status = 'PENDING' AND type = 'REPLAY') as wouldn't be used
-- with the bind params from prisma.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "BulkActionGroup_environmentId_status_type_idx"
ON "BulkActionGroup" ("environmentId", "status", "type");
