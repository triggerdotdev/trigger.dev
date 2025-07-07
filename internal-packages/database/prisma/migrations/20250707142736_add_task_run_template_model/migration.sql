CREATE TABLE "TaskRunTemplate" (
    "id" TEXT NOT NULL,
    "taskSlug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "payload" TEXT,
    "payloadType" TEXT NOT NULL DEFAULT 'application/json',
    "metadata" TEXT,
    "metadataType" TEXT NOT NULL DEFAULT 'application/json',
    "queue" TEXT NOT NULL,
    "delaySeconds" INTEGER,
    "maxAttempts" INTEGER,
    "maxDurationSeconds" INTEGER,
    "tags" TEXT[],
    "machinePreset" TEXT,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRunTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaskRunTemplate_projectId_taskSlug_createdAt_idx" ON "TaskRunTemplate"("projectId", "taskSlug", "createdAt" DESC);