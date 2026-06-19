-- Drop all foreign key constraints that reference TaskRun.id from child tables
-- (no schema change, data intact). Integrity moves to app code so a child row
-- can reference a run in either TaskRun (legacy) or task_run_v2 (new) by scalar.
ALTER TABLE "public"."TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_taskRunId_fkey";
ALTER TABLE "public"."TaskRunDependency" DROP CONSTRAINT IF EXISTS "TaskRunDependency_taskRunId_fkey";
ALTER TABLE "public"."BatchTaskRunItem" DROP CONSTRAINT IF EXISTS "BatchTaskRunItem_taskRunId_fkey";
ALTER TABLE "public"."Checkpoint" DROP CONSTRAINT IF EXISTS "Checkpoint_runId_fkey";
ALTER TABLE "public"."CheckpointRestoreEvent" DROP CONSTRAINT IF EXISTS "CheckpointRestoreEvent_runId_fkey";
ALTER TABLE "public"."ProjectAlert" DROP CONSTRAINT IF EXISTS "ProjectAlert_taskRunId_fkey";
ALTER TABLE "public"."BulkActionItem" DROP CONSTRAINT IF EXISTS "BulkActionItem_sourceRunId_fkey";
ALTER TABLE "public"."BulkActionItem" DROP CONSTRAINT IF EXISTS "BulkActionItem_destinationRunId_fkey";
ALTER TABLE "public"."_TaskRunToTaskRunTag" DROP CONSTRAINT IF EXISTS "_TaskRunToTaskRunTag_A_fkey";
ALTER TABLE "public"."TaskRunExecutionSnapshot" DROP CONSTRAINT IF EXISTS "TaskRunExecutionSnapshot_runId_fkey";
ALTER TABLE "public"."Waitpoint" DROP CONSTRAINT IF EXISTS "Waitpoint_completedByTaskRunId_fkey";
ALTER TABLE "public"."TaskRunWaitpoint" DROP CONSTRAINT IF EXISTS "TaskRunWaitpoint_taskRunId_fkey";
ALTER TABLE "public"."_WaitpointRunConnections" DROP CONSTRAINT IF EXISTS "_WaitpointRunConnections_A_fkey";
ALTER TABLE "public"."PlaygroundConversation" DROP CONSTRAINT IF EXISTS "PlaygroundConversation_runId_fkey";
