/*
  Warnings:

  - You are about to drop the column `parentAttemptId` on the `TaskRun` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "BatchTaskRunItemStatus" AS ENUM ('PENDING', 'FAILED', 'CANCELED', 'COMPLETED');

-- DropForeignKey
ALTER TABLE "TaskRun" DROP CONSTRAINT "TaskRun_parentAttemptId_fkey";

-- AlterTable
ALTER TABLE "TaskRun" DROP COLUMN "parentAttemptId";

-- CreateTable
CREATE TABLE "TaskRunDependency" (
    "id" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "dependentAttemptId" TEXT,
    "dependentBatchRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRunDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchTaskRun" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "taskIdentifier" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "dependentTaskAttemptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BatchTaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchTaskRunItem" (
    "id" TEXT NOT NULL,
    "status" "BatchTaskRunItemStatus" NOT NULL DEFAULT 'PENDING',
    "batchTaskRunId" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BatchTaskRunItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunDependency_taskRunId_key" ON "TaskRunDependency"("taskRunId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunDependency_dependentAttemptId_key" ON "TaskRunDependency"("dependentAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_friendlyId_key" ON "BatchTaskRun"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_dependentTaskAttemptId_key" ON "BatchTaskRun"("dependentTaskAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_runtimeEnvironmentId_idempotencyKey_key" ON "BatchTaskRun"("runtimeEnvironmentId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRunItem_taskRunId_key" ON "BatchTaskRunItem"("taskRunId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRunItem_batchTaskRunId_taskRunId_key" ON "BatchTaskRunItem"("batchTaskRunId", "taskRunId");

-- AddForeignKey
ALTER TABLE "TaskRunDependency" ADD CONSTRAINT "TaskRunDependency_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunDependency" ADD CONSTRAINT "TaskRunDependency_dependentAttemptId_fkey" FOREIGN KEY ("dependentAttemptId") REFERENCES "TaskRunAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunDependency" ADD CONSTRAINT "TaskRunDependency_dependentBatchRunId_fkey" FOREIGN KEY ("dependentBatchRunId") REFERENCES "BatchTaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchTaskRun" ADD CONSTRAINT "BatchTaskRun_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchTaskRun" ADD CONSTRAINT "BatchTaskRun_dependentTaskAttemptId_fkey" FOREIGN KEY ("dependentTaskAttemptId") REFERENCES "TaskRunAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchTaskRunItem" ADD CONSTRAINT "BatchTaskRunItem_batchTaskRunId_fkey" FOREIGN KEY ("batchTaskRunId") REFERENCES "BatchTaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchTaskRunItem" ADD CONSTRAINT "BatchTaskRunItem_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
