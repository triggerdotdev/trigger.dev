-- AlterTable
ALTER TABLE "Waitpoint" ADD COLUMN IF NOT EXISTS "inputStreamId" TEXT,
ADD COLUMN IF NOT EXISTS "inputStreamRunFriendlyId" TEXT;
