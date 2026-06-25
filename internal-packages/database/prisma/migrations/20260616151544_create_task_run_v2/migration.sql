-- CreateTable
CREATE TABLE "public"."task_run_v2" (
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

    CONSTRAINT "task_run_v2_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_run_v2_friendlyId_key" ON "public"."task_run_v2"("friendlyId");

-- CreateIndex
CREATE INDEX "task_run_v2_parentTaskRunId_idx" ON "public"."task_run_v2"("parentTaskRunId");

-- CreateIndex
CREATE INDEX "task_run_v2_spanId_idx" ON "public"."task_run_v2"("spanId");

-- CreateIndex
CREATE INDEX "task_run_v2_parentSpanId_idx" ON "public"."task_run_v2"("parentSpanId");

-- CreateIndex
CREATE INDEX "task_run_v2_runTags_idx" ON "public"."task_run_v2" USING GIN ("runTags" array_ops);

-- CreateIndex
CREATE INDEX "task_run_v2_runtimeEnvironmentId_batchId_idx" ON "public"."task_run_v2"("runtimeEnvironmentId", "batchId");

-- CreateIndex
CREATE INDEX "task_run_v2_runtimeEnvironmentId_createdAt_idx" ON "public"."task_run_v2"("runtimeEnvironmentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "task_run_v2_createdAt_idx" ON "public"."task_run_v2" USING BRIN ("createdAt");

-- CreateIndex
CREATE INDEX "task_run_v2_createdAt_id_idx" ON "public"."task_run_v2"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_run_v2_oneTimeUseToken_key" ON "public"."task_run_v2"("oneTimeUseToken");

-- CreateIndex
CREATE UNIQUE INDEX "task_run_v2_runtimeEnvironmentId_taskIdentifier_idempotency_key" ON "public"."task_run_v2"("runtimeEnvironmentId", "taskIdentifier", "idempotencyKey");
