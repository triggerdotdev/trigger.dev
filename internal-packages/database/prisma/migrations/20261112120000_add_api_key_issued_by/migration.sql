-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "public"."ApiKeyIssuer" AS ENUM ('USER', 'SYSTEM');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "public"."api_keys" ADD COLUMN IF NOT EXISTS "issued_by" "public"."ApiKeyIssuer" NOT NULL DEFAULT 'USER';
