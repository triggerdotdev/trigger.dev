-- DropForeignKey
-- FK 1 of 14: TaskRunAttempt.taskRunId -> TaskRun.id
-- This FK must be dropped to support TaskRun table partitioning where runs
-- may exist in either the legacy TaskRun table or the new TaskRunPartitioned table.
-- Use TaskRunRouter service to query the correct table based on run ID format.
ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_taskRunId_fkey";
