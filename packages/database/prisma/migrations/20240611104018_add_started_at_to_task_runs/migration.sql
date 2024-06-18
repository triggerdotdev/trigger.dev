-- AlterTable
ALTER TABLE
  "TaskRun"
ADD
  COLUMN "startedAt" TIMESTAMP(3);

-- Update all TaskRun to set startedAt = lockedAt
UPDATE
  "TaskRun"
SET
  "startedAt" = "lockedAt";