-- CreateEnum
CREATE TYPE "TaskEventLevel" AS ENUM ('TRACE', 'DEBUG', 'LOG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "TaskEventKind" AS ENUM ('UNSPECIFIED', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER', 'UNRECOGNIZED', 'LOG');

-- CreateEnum
CREATE TYPE "TaskEventStatus" AS ENUM ('UNSET', 'OK', 'ERROR', 'UNRECOGNIZED');

-- CreateTable
CREATE TABLE "TaskEvent" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "spanId" TEXT NOT NULL,
    "parentId" TEXT,
    "tracestate" TEXT,
    "serviceName" TEXT NOT NULL,
    "serviceNamespace" TEXT NOT NULL,
    "level" "TaskEventLevel" NOT NULL DEFAULT 'TRACE',
    "kind" "TaskEventKind" NOT NULL DEFAULT 'INTERNAL',
    "status" "TaskEventStatus" NOT NULL DEFAULT 'UNSET',
    "links" JSONB,
    "events" JSONB,
    "startTime" TIMESTAMP(3) NOT NULL,
    "durationInMs" INTEGER NOT NULL DEFAULT 0,
    "attemptId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "environmentId" TEXT NOT NULL,
    "environmentSlug" TEXT NOT NULL,
    "environmentType" "RuntimeEnvironmentType" NOT NULL,
    "organizationId" TEXT NOT NULL,
    "organizationName" TEXT NOT NULL,
    "organizationSlug" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "projectName" TEXT NOT NULL,
    "projectRef" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "taskSlug" TEXT NOT NULL,
    "taskPath" TEXT NOT NULL,
    "taskExportName" TEXT NOT NULL,
    "metadataStringKeys" TEXT[],
    "metadataStringValues" TEXT[],
    "metadataNumberKeys" TEXT[],
    "metadataNumberValues" INTEGER[],
    "metadataBooleanKeys" TEXT[],
    "metadataBooleanValues" BOOLEAN[],

    CONSTRAINT "TaskEvent_pkey" PRIMARY KEY ("id")
);
