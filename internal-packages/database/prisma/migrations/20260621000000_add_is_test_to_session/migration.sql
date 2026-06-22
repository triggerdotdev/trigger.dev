-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: legacy Test sessions were marked with a "playground" tag. Flag them
-- as test and strip the now-redundant tag (the Test column replaces it), so the
-- list and detail views render consistently without read-time tag filtering.
-- Bounded one-shot over the playground subset; matches existing in-migration
-- backfill precedent. (Prisma wraps each migration in a single transaction, so
-- batching with intermediate commits isn't possible here.)
UPDATE "Session"
SET "isTest" = true, "tags" = array_remove("tags", 'playground')
WHERE 'playground' = ANY("tags");
