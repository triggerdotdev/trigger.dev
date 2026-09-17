-- Support per-parent (createdAt, id) cursor seeks over active preview branches.
-- Prisma cannot declare this partial predicate or a concurrent build. CONCURRENTLY keeps
-- normal writes available; IF NOT EXISTS permits manual pre-creation. Keep one statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "RuntimeEnvironment_preview_archive_scan_idx"
ON "RuntimeEnvironment" ("parentEnvironmentId", "createdAt", "id")
WHERE "type" = 'PREVIEW' AND "archivedAt" IS NULL
AND "parentEnvironmentId" IS NOT NULL AND "branchName" IS NOT NULL;
