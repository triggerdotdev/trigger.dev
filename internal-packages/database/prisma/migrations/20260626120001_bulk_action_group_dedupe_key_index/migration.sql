CREATE INDEX CONCURRENTLY IF NOT EXISTS "BulkActionGroup_environmentId_type_dedupeKey_idx"
ON "BulkActionGroup" ("environmentId", "type", "dedupeKey")
WHERE "dedupeKey" IS NOT NULL;
