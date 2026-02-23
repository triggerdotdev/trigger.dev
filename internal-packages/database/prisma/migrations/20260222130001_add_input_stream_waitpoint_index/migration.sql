-- CreateIndex (CONCURRENTLY must be in its own migration)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Waitpoint_inputStream_idx"
ON "Waitpoint" ("environmentId", "inputStreamRunFriendlyId", "inputStreamId", "status")
WHERE "inputStreamRunFriendlyId" IS NOT NULL;
