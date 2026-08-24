CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "RuntimeEnvironment_projectId_type_staging_preview_root_key"
ON "RuntimeEnvironment" ("projectId", "type")
WHERE "parentEnvironmentId" IS NULL
  AND "type" IN ('STAGING', 'PREVIEW');
