-- Run-ops DB split: drop run-ops tables' cross-database FKs to control-plane tables (they
-- can't be enforced on the run-ops DB, which has no control-plane tables). Mirrors the
-- earlier TaskRun/BatchTaskRun drops; IF EXISTS so it's idempotent across both databases.

-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

-- Waitpoint
ALTER TABLE "Waitpoint" DROP CONSTRAINT IF EXISTS "Waitpoint_projectId_fkey";
ALTER TABLE "Waitpoint" DROP CONSTRAINT IF EXISTS "Waitpoint_environmentId_fkey";

-- TaskRunWaitpoint
ALTER TABLE "TaskRunWaitpoint" DROP CONSTRAINT IF EXISTS "TaskRunWaitpoint_projectId_fkey";

-- TaskRunCheckpoint
ALTER TABLE "TaskRunCheckpoint" DROP CONSTRAINT IF EXISTS "TaskRunCheckpoint_projectId_fkey";
ALTER TABLE "TaskRunCheckpoint" DROP CONSTRAINT IF EXISTS "TaskRunCheckpoint_runtimeEnvironmentId_fkey";

-- TaskRunAttempt
ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_backgroundWorkerId_fkey";
ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_backgroundWorkerTaskId_fkey";
ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_runtimeEnvironmentId_fkey";

-- TaskRunTag
ALTER TABLE "TaskRunTag" DROP CONSTRAINT IF EXISTS "TaskRunTag_projectId_fkey";

-- WaitpointTag
ALTER TABLE "WaitpointTag" DROP CONSTRAINT IF EXISTS "WaitpointTag_projectId_fkey";
ALTER TABLE "WaitpointTag" DROP CONSTRAINT IF EXISTS "WaitpointTag_environmentId_fkey";
