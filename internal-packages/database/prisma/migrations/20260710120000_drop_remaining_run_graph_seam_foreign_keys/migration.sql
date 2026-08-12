-- Run-graph tables are queried via dedicated clients; the remaining cross-graph foreign key
-- constraints between control-plane tables and run-graph tables are removed so neither side
-- needs the other's tables present to enforce them. Referential integrity is app-enforced,
-- matching the sibling FK removals. IF EXISTS keeps this idempotent across databases.

-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

-- BulkActionItem
ALTER TABLE "BulkActionItem" DROP CONSTRAINT IF EXISTS "BulkActionItem_sourceRunId_fkey";
ALTER TABLE "BulkActionItem" DROP CONSTRAINT IF EXISTS "BulkActionItem_destinationRunId_fkey";

-- PlaygroundConversation
ALTER TABLE "PlaygroundConversation" DROP CONSTRAINT IF EXISTS "PlaygroundConversation_runId_fkey";

-- Checkpoint
ALTER TABLE "Checkpoint" DROP CONSTRAINT IF EXISTS "Checkpoint_projectId_fkey";
ALTER TABLE "Checkpoint" DROP CONSTRAINT IF EXISTS "Checkpoint_runtimeEnvironmentId_fkey";

-- CheckpointRestoreEvent
ALTER TABLE "CheckpointRestoreEvent" DROP CONSTRAINT IF EXISTS "CheckpointRestoreEvent_projectId_fkey";
ALTER TABLE "CheckpointRestoreEvent" DROP CONSTRAINT IF EXISTS "CheckpointRestoreEvent_runtimeEnvironmentId_fkey";

-- TaskRunAttempt
ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_queueId_fkey";
