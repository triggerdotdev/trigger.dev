-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

-- DropForeignKey
ALTER TABLE "BatchTaskRun" DROP CONSTRAINT IF EXISTS "BatchTaskRun_runtimeEnvironmentId_fkey";
