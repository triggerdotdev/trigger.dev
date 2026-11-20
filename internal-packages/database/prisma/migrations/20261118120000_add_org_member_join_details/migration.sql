-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "public"."OrgMember"
  ADD COLUMN IF NOT EXISTS "invitedById" TEXT,
  ADD COLUMN IF NOT EXISTS "joinMethod" TEXT;
