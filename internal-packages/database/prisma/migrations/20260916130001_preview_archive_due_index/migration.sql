-- Match the due-policy filter and ordering so cleanup starts with scheduled preview roots.
-- Prisma cannot declare this partial predicate or a concurrent build. CONCURRENTLY keeps
-- normal writes available; IF NOT EXISTS permits manual pre-creation. Keep one statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "RuntimeEnvironment_preview_archive_due_idx"
ON "RuntimeEnvironment" ("previewAutoArchiveNextCheckAt", "id")
WHERE "type" = 'PREVIEW' AND "parentEnvironmentId" IS NULL
AND "isBranchableEnvironment" = true AND "archivedAt" IS NULL
AND "previewAutoArchiveAfterDays" IS NOT NULL AND "previewAutoArchiveNextCheckAt" IS NOT NULL;
