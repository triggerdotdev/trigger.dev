-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "public"."Organization" ADD COLUMN IF NOT EXISTS "mfaRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "public"."Organization" ADD COLUMN IF NOT EXISTS "mfaStepUpActions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "public"."Organization" ADD COLUMN IF NOT EXISTS "mfaStepUpWindowMinutes" INTEGER NOT NULL DEFAULT 5;
