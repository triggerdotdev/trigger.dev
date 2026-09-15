CREATE INDEX CONCURRENTLY IF NOT EXISTS "RuntimeEnvironment_pauseSource_organizationId_idx"
ON "RuntimeEnvironment" ("pauseSource", "organizationId")
WHERE "pauseSource" IS NOT NULL;
