-- Add policy and durable sweep progress together. IF NOT EXISTS supports pre-applying
-- this exact DDL before deployment; existing column definitions are verified manually.
ALTER TABLE "RuntimeEnvironment"
ADD COLUMN IF NOT EXISTS "previewAutoArchiveAfterDays" INTEGER,
ADD COLUMN IF NOT EXISTS "previewAutoArchiveExcludedBranches" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "previewAutoArchiveNextCheckAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "previewAutoArchiveCursorCreatedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "previewAutoArchiveCursorId" TEXT;
