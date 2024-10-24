-- CreateEnum
CREATE TYPE "RunEngineVersion" AS ENUM ('V1', 'V2');

-- CreateEnum
CREATE TYPE "TaskRunExecutionStatus" AS ENUM ('RUN_CREATED', 'QUEUED', 'PENDING_EXECUTING', 'EXECUTING', 'EXECUTING_WITH_WAITPOINTS', 'BLOCKED_BY_WAITPOINTS', 'PENDING_CANCEL', 'FINISHED');

-- CreateEnum
CREATE TYPE "TaskRunCheckpointType" AS ENUM ('DOCKER', 'KUBERNETES');

-- CreateEnum
CREATE TYPE "WaitpointType" AS ENUM ('RUN', 'DATETIME', 'EVENT');

-- CreateEnum
CREATE TYPE "WaitpointStatus" AS ENUM ('PENDING', 'COMPLETED');

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "attemptNumber" INTEGER,
ADD COLUMN     "engine" "RunEngineVersion" NOT NULL DEFAULT 'V1',
ADD COLUMN     "masterQueue" TEXT NOT NULL DEFAULT 'main',
ADD COLUMN     "secondaryMasterQueue" TEXT;

-- CreateTable
CREATE TABLE "TaskRunExecutionSnapshot" (
    "id" TEXT NOT NULL,
    "engine" "RunEngineVersion" NOT NULL DEFAULT 'V2',
    "executionStatus" "TaskRunExecutionStatus" NOT NULL,
    "description" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "runStatus" "TaskRunStatus" NOT NULL,
    "attemptNumber" INTEGER,
    "checkpointId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRunExecutionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRunCheckpoint" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "type" "TaskRunCheckpointType" NOT NULL,
    "location" TEXT NOT NULL,
    "imageRef" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" TEXT,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRunCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Waitpoint" (
    "id" TEXT NOT NULL,
    "type" "WaitpointType" NOT NULL,
    "status" "WaitpointStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "userProvidedIdempotencyKey" BOOLEAN NOT NULL,
    "inactiveIdempotencyKey" TEXT,
    "completedByTaskRunId" TEXT,
    "completedAfter" TIMESTAMP(3),
    "output" TEXT,
    "outputType" TEXT NOT NULL DEFAULT 'application/json',
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Waitpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRunWaitpoint" (
    "id" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "waitpointId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRunWaitpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Worker" (
    "id" TEXT NOT NULL,

    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerGroup" (
    "id" TEXT NOT NULL,
    "masterQueue" TEXT NOT NULL,

    CONSTRAINT "WorkerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_completedWaitpoints" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "TaskRunExecutionSnapshot_runId_createdAt_idx" ON "TaskRunExecutionSnapshot"("runId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunCheckpoint_friendlyId_key" ON "TaskRunCheckpoint"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_completedByTaskRunId_key" ON "Waitpoint"("completedByTaskRunId");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_environmentId_idempotencyKey_key" ON "Waitpoint"("environmentId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TaskRunWaitpoint_taskRunId_idx" ON "TaskRunWaitpoint"("taskRunId");

-- CreateIndex
CREATE INDEX "TaskRunWaitpoint_waitpointId_idx" ON "TaskRunWaitpoint"("waitpointId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunWaitpoint_taskRunId_waitpointId_key" ON "TaskRunWaitpoint"("taskRunId", "waitpointId");

-- CreateIndex
CREATE UNIQUE INDEX "_completedWaitpoints_AB_unique" ON "_completedWaitpoints"("A", "B");

-- CreateIndex
CREATE INDEX "_completedWaitpoints_B_index" ON "_completedWaitpoints"("B");

-- AddForeignKey
ALTER TABLE "TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "TaskRunCheckpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunCheckpoint" ADD CONSTRAINT "TaskRunCheckpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunCheckpoint" ADD CONSTRAINT "TaskRunCheckpoint_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_completedByTaskRunId_fkey" FOREIGN KEY ("completedByTaskRunId") REFERENCES "TaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunWaitpoint" ADD CONSTRAINT "TaskRunWaitpoint_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunWaitpoint" ADD CONSTRAINT "TaskRunWaitpoint_waitpointId_fkey" FOREIGN KEY ("waitpointId") REFERENCES "Waitpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunWaitpoint" ADD CONSTRAINT "TaskRunWaitpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_completedWaitpoints" ADD CONSTRAINT "_completedWaitpoints_A_fkey" FOREIGN KEY ("A") REFERENCES "TaskRunExecutionSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_completedWaitpoints" ADD CONSTRAINT "_completedWaitpoints_B_fkey" FOREIGN KEY ("B") REFERENCES "Waitpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
