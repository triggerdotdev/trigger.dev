-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "public"."TaskExecutionMode" AS ENUM ('STANDARD', 'SANDBOX');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "public"."BackgroundWorkerTask"
  ADD COLUMN IF NOT EXISTS "executionMode" "public"."TaskExecutionMode" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN IF NOT EXISTS "executionPolicy" JSONB;
