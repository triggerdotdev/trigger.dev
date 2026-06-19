-- Dev environments are now branchable, backfill all existing
UPDATE "RuntimeEnvironment"
SET "isBranchableEnvironment" = true
WHERE "type" = 'DEVELOPMENT'
  AND "isBranchableEnvironment" = false
  AND "archivedAt" IS NULL;
