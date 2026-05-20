-- Drop all foreign key constraints on TaskRun (no schema change, data intact)
ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "TaskRun_runtimeEnvironmentId_fkey";
ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "TaskRun_projectId_fkey";
ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "TaskRun_lockedById_fkey";
ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "TaskRun_lockedToVersionId_fkey";
ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "TaskRun_rootTaskRunId_fkey";
ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "TaskRun_parentTaskRunId_fkey";
ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "TaskRun_parentTaskRunAttemptId_fkey";
ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "TaskRun_batchId_fkey";
