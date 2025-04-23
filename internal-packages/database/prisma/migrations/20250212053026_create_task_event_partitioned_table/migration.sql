-- CreateTable
CREATE TABLE "TaskEventPartitioned" (
  "id" text NOT NULL,
  "message" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "spanId" TEXT NOT NULL,
  "parentId" TEXT,
  "tracestate" TEXT,
  "isError" BOOLEAN NOT NULL DEFAULT false,
  "isPartial" BOOLEAN NOT NULL DEFAULT false,
  "isCancelled" BOOLEAN NOT NULL DEFAULT false,
  "serviceName" TEXT NOT NULL,
  "serviceNamespace" TEXT NOT NULL,
  "level" "TaskEventLevel" NOT NULL DEFAULT 'TRACE',
  "kind" "TaskEventKind" NOT NULL DEFAULT 'INTERNAL',
  "status" "TaskEventStatus" NOT NULL DEFAULT 'UNSET',
  "links" JSONB,
  "events" JSONB,
  "startTime" BIGINT NOT NULL,
  "duration" BIGINT NOT NULL DEFAULT 0,
  "attemptId" TEXT,
  "attemptNumber" INTEGER,
  "environmentId" TEXT NOT NULL,
  "environmentType" "RuntimeEnvironmentType" NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "projectRef" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "runIsTest" BOOLEAN NOT NULL DEFAULT false,
  "idempotencyKey" TEXT,
  "taskSlug" TEXT NOT NULL,
  "taskPath" TEXT,
  "taskExportName" TEXT,
  "workerId" TEXT,
  "workerVersion" TEXT,
  "queueId" TEXT,
  "queueName" TEXT,
  "batchId" TEXT,
  "properties" JSONB NOT NULL,
  "metadata" JSONB,
  "style" JSONB,
  "output" JSONB,
  "outputType" TEXT,
  "payload" JSONB,
  "payloadType" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "usageDurationMs" INTEGER NOT NULL DEFAULT 0,
  "usageCostInCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "machinePreset" TEXT,
  "machinePresetCpu" DOUBLE PRECISION,
  "machinePresetMemory" DOUBLE PRECISION,
  "machinePresetCentsPerMs" DOUBLE PRECISION,
  CONSTRAINT "TaskEventPartitioned_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");

-- CreateIndex
CREATE INDEX "TaskEventPartitioned_traceId_idx" ON "TaskEventPartitioned"("traceId");

-- CreateIndex
CREATE INDEX "TaskEventPartitioned_spanId_idx" ON "TaskEventPartitioned"("spanId");

-- CreateIndex
CREATE INDEX "TaskEventPartitioned_runId_idx" ON "TaskEventPartitioned"("runId");