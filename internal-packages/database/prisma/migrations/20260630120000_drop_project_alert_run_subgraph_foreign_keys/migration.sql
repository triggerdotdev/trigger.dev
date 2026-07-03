-- Run-ops DB split: drop ProjectAlert's cross-DB FKs into the run subgraph (taskRunId -> TaskRun,
-- taskRunAttemptId -> TaskRunAttempt). A ksuid run lives only on the dedicated run-ops DB so the FK
-- can't be enforced; scalar columns are kept and the run is resolved via runStore.findRun. Mirrors
-- ca1a4e18e; IF EXISTS so it's idempotent across both databases.

-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

ALTER TABLE "ProjectAlert" DROP CONSTRAINT IF EXISTS "ProjectAlert_taskRunId_fkey";
ALTER TABLE "ProjectAlert" DROP CONSTRAINT IF EXISTS "ProjectAlert_taskRunAttemptId_fkey";
