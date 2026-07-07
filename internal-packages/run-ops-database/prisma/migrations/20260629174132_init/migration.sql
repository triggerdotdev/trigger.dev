-- CreateEnum
CREATE TYPE "public"."RuntimeEnvironmentType" AS ENUM ('PRODUCTION', 'STAGING', 'DEVELOPMENT', 'PREVIEW');

-- CreateEnum
CREATE TYPE "public"."TaskRunStatus" AS ENUM ('DELAYED', 'PENDING', 'PENDING_VERSION', 'WAITING_FOR_DEPLOY', 'DEQUEUED', 'EXECUTING', 'WAITING_TO_RESUME', 'RETRYING_AFTER_FAILURE', 'PAUSED', 'CANCELED', 'INTERRUPTED', 'COMPLETED_SUCCESSFULLY', 'COMPLETED_WITH_ERRORS', 'SYSTEM_FAILURE', 'CRASHED', 'EXPIRED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "public"."RunEngineVersion" AS ENUM ('V1', 'V2');

-- CreateEnum
CREATE TYPE "public"."TaskRunExecutionStatus" AS ENUM ('RUN_CREATED', 'DELAYED', 'QUEUED', 'QUEUED_EXECUTING', 'PENDING_EXECUTING', 'EXECUTING', 'EXECUTING_WITH_WAITPOINTS', 'SUSPENDED', 'PENDING_CANCEL', 'FINISHED');

-- CreateEnum
CREATE TYPE "public"."TaskRunCheckpointType" AS ENUM ('DOCKER', 'KUBERNETES', 'COMPUTE');

-- CreateEnum
CREATE TYPE "public"."WaitpointType" AS ENUM ('RUN', 'DATETIME', 'MANUAL', 'BATCH');

-- CreateEnum
CREATE TYPE "public"."WaitpointStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "public"."TaskRunAttemptStatus" AS ENUM ('PENDING', 'EXECUTING', 'PAUSED', 'FAILED', 'CANCELED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "public"."BatchTaskRunStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'PARTIAL_FAILED', 'ABORTED');

-- CreateEnum
CREATE TYPE "public"."BatchTaskRunItemStatus" AS ENUM ('PENDING', 'FAILED', 'CANCELED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "public"."CheckpointType" AS ENUM ('DOCKER', 'KUBERNETES');

-- CreateEnum
CREATE TYPE "public"."CheckpointRestoreEventType" AS ENUM ('CHECKPOINT', 'RESTORE');

-- CreateTable
CREATE TABLE "public"."TaskRun" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL DEFAULT 0,
    "friendlyId" TEXT NOT NULL,
    "engine" "public"."RunEngineVersion" NOT NULL DEFAULT 'V1',
    "status" "public"."TaskRunStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "idempotencyKey" TEXT,
    "idempotencyKeyExpiresAt" TIMESTAMP(3),
    "idempotencyKeyOptions" JSONB,
    "debounce" JSONB,
    "taskIdentifier" TEXT NOT NULL,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "payload" TEXT NOT NULL,
    "payloadType" TEXT NOT NULL DEFAULT 'application/json',
    "context" JSONB,
    "traceContext" JSONB,
    "traceId" TEXT NOT NULL,
    "spanId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "environmentType" "public"."RuntimeEnvironmentType",
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "queue" TEXT NOT NULL,
    "lockedQueueId" TEXT,
    "masterQueue" TEXT NOT NULL DEFAULT 'main',
    "region" TEXT,
    "secondaryMasterQueue" TEXT,
    "attemptNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "runTags" TEXT[],
    "taskVersion" TEXT,
    "sdkVersion" TEXT,
    "cliVersion" TEXT,
    "startedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "machinePreset" TEXT,
    "usageDurationMs" INTEGER NOT NULL DEFAULT 0,
    "costInCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "baseCostInCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "lockedById" TEXT,
    "lockedToVersionId" TEXT,
    "priorityMs" INTEGER NOT NULL DEFAULT 0,
    "concurrencyKey" TEXT,
    "delayUntil" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3),
    "ttl" TEXT,
    "expiredAt" TIMESTAMP(3),
    "maxAttempts" INTEGER,
    "lockedRetryConfig" JSONB,
    "oneTimeUseToken" TEXT,
    "taskEventStore" TEXT NOT NULL DEFAULT 'taskEvent',
    "queueTimestamp" TIMESTAMP(3),
    "scheduleInstanceId" TEXT,
    "scheduleId" TEXT,
    "bulkActionGroupIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "logsDeletedAt" TIMESTAMP(3),
    "replayedFromTaskRunFriendlyId" TEXT,
    "rootTaskRunId" TEXT,
    "parentTaskRunId" TEXT,
    "parentTaskRunAttemptId" TEXT,
    "batchId" TEXT,
    "resumeParentOnCompletion" BOOLEAN NOT NULL DEFAULT false,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "parentSpanId" TEXT,
    "runChainState" JSONB,
    "seedMetadata" TEXT,
    "seedMetadataType" TEXT NOT NULL DEFAULT 'application/json',
    "metadata" TEXT,
    "metadataType" TEXT NOT NULL DEFAULT 'application/json',
    "metadataVersion" INTEGER NOT NULL DEFAULT 1,
    "annotations" JSONB,
    "isWarmStart" BOOLEAN,
    "output" TEXT,
    "outputType" TEXT NOT NULL DEFAULT 'application/json',
    "error" JSONB,
    "planType" TEXT,
    "maxDurationInSeconds" INTEGER,
    "realtimeStreamsVersion" TEXT NOT NULL DEFAULT 'v1',
    "realtimeStreams" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "streamBasinName" TEXT,

    CONSTRAINT "TaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunExecutionSnapshot" (
    "id" TEXT NOT NULL,
    "engine" "public"."RunEngineVersion" NOT NULL DEFAULT 'V2',
    "executionStatus" "public"."TaskRunExecutionStatus" NOT NULL,
    "description" TEXT NOT NULL,
    "isValid" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "previousSnapshotId" TEXT,
    "runId" TEXT NOT NULL,
    "runStatus" "public"."TaskRunStatus" NOT NULL,
    "batchId" TEXT,
    "attemptNumber" INTEGER,
    "environmentId" TEXT NOT NULL,
    "environmentType" "public"."RuntimeEnvironmentType" NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "completedWaitpointOrder" TEXT[],
    "checkpointId" TEXT,
    "workerId" TEXT,
    "runnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "TaskRunExecutionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunCheckpoint" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "type" "public"."TaskRunCheckpointType" NOT NULL,
    "location" TEXT NOT NULL,
    "imageRef" TEXT,
    "reason" TEXT,
    "metadata" TEXT,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRunCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Waitpoint" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "type" "public"."WaitpointType" NOT NULL,
    "status" "public"."WaitpointStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "userProvidedIdempotencyKey" BOOLEAN NOT NULL,
    "idempotencyKeyExpiresAt" TIMESTAMP(3),
    "inactiveIdempotencyKey" TEXT,
    "completedByTaskRunId" TEXT,
    "completedAfter" TIMESTAMP(3),
    "completedByBatchId" TEXT,
    "output" TEXT,
    "outputType" TEXT NOT NULL DEFAULT 'application/json',
    "outputIsError" BOOLEAN NOT NULL DEFAULT false,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[],

    CONSTRAINT "Waitpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunWaitpoint" (
    "id" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "waitpointId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "spanIdToComplete" TEXT,
    "batchId" TEXT,
    "batchIndex" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRunWaitpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WaitpointRunConnection" (
    "id" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "waitpointId" TEXT NOT NULL,

    CONSTRAINT "WaitpointRunConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CompletedWaitpoint" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "waitpointId" TEXT NOT NULL,

    CONSTRAINT "CompletedWaitpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WaitpointTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitpointTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskRunTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunDependency" (
    "id" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "checkpointEventId" TEXT,
    "dependentAttemptId" TEXT,
    "dependentBatchRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resumedAt" TIMESTAMP(3),

    CONSTRAINT "TaskRunDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunAttempt" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL DEFAULT 0,
    "friendlyId" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "backgroundWorkerId" TEXT NOT NULL,
    "backgroundWorkerTaskId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,
    "status" "public"."TaskRunAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "usageDurationMs" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,
    "output" TEXT,
    "outputType" TEXT NOT NULL DEFAULT 'application/json',

    CONSTRAINT "TaskRunAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BatchTaskRun" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "idempotencyKeyExpiresAt" TIMESTAMP(3),
    "status" "public"."BatchTaskRunStatus" NOT NULL DEFAULT 'PENDING',
    "runtimeEnvironmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "runIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "payload" TEXT,
    "payloadType" TEXT NOT NULL DEFAULT 'application/json',
    "options" JSONB,
    "batchVersion" TEXT NOT NULL DEFAULT 'v1',
    "sealed" BOOLEAN NOT NULL DEFAULT false,
    "sealedAt" TIMESTAMP(3),
    "expectedCount" INTEGER NOT NULL DEFAULT 0,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "resumedAt" TIMESTAMP(3),
    "processingJobsCount" INTEGER NOT NULL DEFAULT 0,
    "processingJobsExpectedCount" INTEGER NOT NULL DEFAULT 0,
    "oneTimeUseToken" TEXT,
    "processingStartedAt" TIMESTAMP(3),
    "processingCompletedAt" TIMESTAMP(3),
    "successfulRunCount" INTEGER,
    "failedRunCount" INTEGER,
    "taskIdentifier" TEXT,
    "checkpointEventId" TEXT,
    "dependentTaskAttemptId" TEXT,

    CONSTRAINT "BatchTaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BatchTaskRunItem" (
    "id" TEXT NOT NULL,
    "status" "public"."BatchTaskRunItemStatus" NOT NULL DEFAULT 'PENDING',
    "batchTaskRunId" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "taskRunAttemptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BatchTaskRunItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BatchTaskRunError" (
    "id" TEXT NOT NULL,
    "batchTaskRunId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "taskIdentifier" TEXT NOT NULL,
    "payload" TEXT,
    "options" JSONB,
    "error" TEXT NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatchTaskRunError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Checkpoint" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "type" "public"."CheckpointType" NOT NULL,
    "location" TEXT NOT NULL,
    "imageRef" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" TEXT,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "attemptNumber" INTEGER,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CheckpointRestoreEvent" (
    "id" TEXT NOT NULL,
    "type" "public"."CheckpointRestoreEventType" NOT NULL,
    "reason" TEXT,
    "metadata" TEXT,
    "checkpointId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckpointRestoreEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskRun_friendlyId_key" ON "public"."TaskRun"("friendlyId");

-- CreateIndex
CREATE INDEX "TaskRun_parentTaskRunId_idx" ON "public"."TaskRun"("parentTaskRunId");

-- CreateIndex
CREATE INDEX "TaskRun_spanId_idx" ON "public"."TaskRun"("spanId");

-- CreateIndex
CREATE INDEX "TaskRun_parentSpanId_idx" ON "public"."TaskRun"("parentSpanId");

-- CreateIndex
CREATE INDEX "TaskRun_runTags_idx" ON "public"."TaskRun" USING GIN ("runTags" array_ops);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_batchId_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "batchId");

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_createdAt_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "TaskRun_createdAt_idx" ON "public"."TaskRun" USING BRIN ("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRun_oneTimeUseToken_key" ON "public"."TaskRun"("oneTimeUseToken");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRun_runtimeEnvironmentId_taskIdentifier_idempotencyKey_key" ON "public"."TaskRun"("runtimeEnvironmentId", "taskIdentifier", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TaskRunExecutionSnapshot_runId_isValid_createdAt_idx" ON "public"."TaskRunExecutionSnapshot"("runId", "isValid", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunCheckpoint_friendlyId_key" ON "public"."TaskRunCheckpoint"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_friendlyId_key" ON "public"."Waitpoint"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_completedByTaskRunId_key" ON "public"."Waitpoint"("completedByTaskRunId");

-- CreateIndex
CREATE INDEX "Waitpoint_completedByBatchId_idx" ON "public"."Waitpoint"("completedByBatchId");

-- CreateIndex
CREATE INDEX "Waitpoint_environmentId_type_createdAt_idx" ON "public"."Waitpoint"("environmentId", "type", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Waitpoint_environmentId_type_status_idx" ON "public"."Waitpoint"("environmentId", "type", "status");

-- CreateIndex
CREATE INDEX "Waitpoint_environmentId_type_id_idx" ON "public"."Waitpoint"("environmentId", "type", "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_environmentId_idempotencyKey_key" ON "public"."Waitpoint"("environmentId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TaskRunWaitpoint_taskRunId_idx" ON "public"."TaskRunWaitpoint"("taskRunId");

-- CreateIndex
CREATE INDEX "TaskRunWaitpoint_waitpointId_idx" ON "public"."TaskRunWaitpoint"("waitpointId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunWaitpoint_taskRunId_waitpointId_batchIndex_key" ON "public"."TaskRunWaitpoint"("taskRunId", "waitpointId", "batchIndex");

-- CreateIndex
CREATE INDEX "WaitpointRunConnection_taskRunId_idx" ON "public"."WaitpointRunConnection"("taskRunId");

-- CreateIndex
CREATE INDEX "WaitpointRunConnection_waitpointId_idx" ON "public"."WaitpointRunConnection"("waitpointId");

-- CreateIndex
CREATE UNIQUE INDEX "WaitpointRunConnection_taskRunId_waitpointId_key" ON "public"."WaitpointRunConnection"("taskRunId", "waitpointId");

-- CreateIndex
CREATE INDEX "CompletedWaitpoint_snapshotId_idx" ON "public"."CompletedWaitpoint"("snapshotId");

-- CreateIndex
CREATE INDEX "CompletedWaitpoint_waitpointId_idx" ON "public"."CompletedWaitpoint"("waitpointId");

-- CreateIndex
CREATE UNIQUE INDEX "CompletedWaitpoint_snapshotId_waitpointId_key" ON "public"."CompletedWaitpoint"("snapshotId", "waitpointId");

-- CreateIndex
CREATE UNIQUE INDEX "WaitpointTag_environmentId_name_key" ON "public"."WaitpointTag"("environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunTag_friendlyId_key" ON "public"."TaskRunTag"("friendlyId");

-- CreateIndex
CREATE INDEX "TaskRunTag_name_id_idx" ON "public"."TaskRunTag"("name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunTag_projectId_name_key" ON "public"."TaskRunTag"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunDependency_taskRunId_key" ON "public"."TaskRunDependency"("taskRunId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunDependency_checkpointEventId_key" ON "public"."TaskRunDependency"("checkpointEventId");

-- CreateIndex
CREATE INDEX "TaskRunDependency_dependentAttemptId_idx" ON "public"."TaskRunDependency"("dependentAttemptId");

-- CreateIndex
CREATE INDEX "TaskRunDependency_dependentBatchRunId_idx" ON "public"."TaskRunDependency"("dependentBatchRunId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunAttempt_friendlyId_key" ON "public"."TaskRunAttempt"("friendlyId");

-- CreateIndex
CREATE INDEX "TaskRunAttempt_taskRunId_idx" ON "public"."TaskRunAttempt"("taskRunId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunAttempt_taskRunId_number_key" ON "public"."TaskRunAttempt"("taskRunId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_friendlyId_key" ON "public"."BatchTaskRun"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_checkpointEventId_key" ON "public"."BatchTaskRun"("checkpointEventId");

-- CreateIndex
CREATE INDEX "BatchTaskRun_dependentTaskAttemptId_idx" ON "public"."BatchTaskRun"("dependentTaskAttemptId");

-- CreateIndex
CREATE INDEX "BatchTaskRun_runtimeEnvironmentId_id_idx" ON "public"."BatchTaskRun"("runtimeEnvironmentId", "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_oneTimeUseToken_key" ON "public"."BatchTaskRun"("oneTimeUseToken");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_runtimeEnvironmentId_idempotencyKey_key" ON "public"."BatchTaskRun"("runtimeEnvironmentId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "idx_batchtaskrunitem_taskrunattempt" ON "public"."BatchTaskRunItem"("taskRunAttemptId");

-- CreateIndex
CREATE INDEX "idx_batchtaskrunitem_taskrun" ON "public"."BatchTaskRunItem"("taskRunId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRunItem_batchTaskRunId_taskRunId_key" ON "public"."BatchTaskRunItem"("batchTaskRunId", "taskRunId");

-- CreateIndex
CREATE INDEX "BatchTaskRunError_batchTaskRunId_idx" ON "public"."BatchTaskRunError"("batchTaskRunId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRunError_batchTaskRunId_index_key" ON "public"."BatchTaskRunError"("batchTaskRunId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "Checkpoint_friendlyId_key" ON "public"."Checkpoint"("friendlyId");

-- CreateIndex
CREATE INDEX "Checkpoint_attemptId_idx" ON "public"."Checkpoint"("attemptId");

-- CreateIndex
CREATE INDEX "Checkpoint_runId_idx" ON "public"."Checkpoint"("runId");

-- CreateIndex
CREATE INDEX "CheckpointRestoreEvent_checkpointId_idx" ON "public"."CheckpointRestoreEvent"("checkpointId");

-- CreateIndex
CREATE INDEX "CheckpointRestoreEvent_runId_idx" ON "public"."CheckpointRestoreEvent"("runId");

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_rootTaskRunId_fkey" FOREIGN KEY ("rootTaskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_parentTaskRunId_fkey" FOREIGN KEY ("parentTaskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_parentTaskRunAttemptId_fkey" FOREIGN KEY ("parentTaskRunAttemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."BatchTaskRun"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "public"."TaskRunCheckpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunDependency" ADD CONSTRAINT "TaskRunDependency_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunDependency" ADD CONSTRAINT "TaskRunDependency_checkpointEventId_fkey" FOREIGN KEY ("checkpointEventId") REFERENCES "public"."CheckpointRestoreEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunDependency" ADD CONSTRAINT "TaskRunDependency_dependentAttemptId_fkey" FOREIGN KEY ("dependentAttemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunDependency" ADD CONSTRAINT "TaskRunDependency_dependentBatchRunId_fkey" FOREIGN KEY ("dependentBatchRunId") REFERENCES "public"."BatchTaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunAttempt" ADD CONSTRAINT "TaskRunAttempt_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BatchTaskRun" ADD CONSTRAINT "BatchTaskRun_checkpointEventId_fkey" FOREIGN KEY ("checkpointEventId") REFERENCES "public"."CheckpointRestoreEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BatchTaskRun" ADD CONSTRAINT "BatchTaskRun_dependentTaskAttemptId_fkey" FOREIGN KEY ("dependentTaskAttemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BatchTaskRunItem" ADD CONSTRAINT "BatchTaskRunItem_batchTaskRunId_fkey" FOREIGN KEY ("batchTaskRunId") REFERENCES "public"."BatchTaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BatchTaskRunItem" ADD CONSTRAINT "BatchTaskRunItem_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BatchTaskRunItem" ADD CONSTRAINT "BatchTaskRunItem_taskRunAttemptId_fkey" FOREIGN KEY ("taskRunAttemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BatchTaskRunError" ADD CONSTRAINT "BatchTaskRunError_batchTaskRunId_fkey" FOREIGN KEY ("batchTaskRunId") REFERENCES "public"."BatchTaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Checkpoint" ADD CONSTRAINT "Checkpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Checkpoint" ADD CONSTRAINT "Checkpoint_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CheckpointRestoreEvent" ADD CONSTRAINT "CheckpointRestoreEvent_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "public"."Checkpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CheckpointRestoreEvent" ADD CONSTRAINT "CheckpointRestoreEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CheckpointRestoreEvent" ADD CONSTRAINT "CheckpointRestoreEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
