/*
  Warnings:

  - You are about to drop the column `backgroundWorkerId` on the `TaskRun` table. All the data in the column will be lost.
  - You are about to drop the column `backgroundWorkerTaskId` on the `TaskRun` table. All the data in the column will be lost.
  - You are about to drop the column `completedAt` on the `TaskRun` table. All the data in the column will be lost.
  - You are about to drop the column `error` on the `TaskRun` table. All the data in the column will be lost.
  - You are about to drop the column `externalRef` on the `TaskRun` table. All the data in the column will be lost.
  - You are about to drop the column `output` on the `TaskRun` table. All the data in the column will be lost.
  - You are about to drop the column `outputType` on the `TaskRun` table. All the data in the column will be lost.
  - You are about to drop the column `startedAt` on the `TaskRun` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `TaskRun` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "TaskRunAttemptStatus" AS ENUM ('PENDING', 'EXECUTING', 'PAUSED', 'FAILED', 'CANCELED', 'COMPLETED');

-- DropForeignKey
ALTER TABLE "TaskRun" DROP CONSTRAINT "TaskRun_backgroundWorkerId_fkey";

-- DropForeignKey
ALTER TABLE "TaskRun" DROP CONSTRAINT "TaskRun_backgroundWorkerTaskId_fkey";

-- DropIndex
DROP INDEX "TaskRun_externalRef_key";

-- AlterTable
ALTER TABLE "TaskRun" DROP COLUMN "backgroundWorkerId",
DROP COLUMN "backgroundWorkerTaskId",
DROP COLUMN "completedAt",
DROP COLUMN "error",
DROP COLUMN "externalRef",
DROP COLUMN "output",
DROP COLUMN "outputType",
DROP COLUMN "startedAt",
DROP COLUMN "status",
ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "lockedById" TEXT;

-- DropEnum
DROP TYPE "TaskRunStatus";

-- CreateTable
CREATE TABLE "TaskTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRunAttempt" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL DEFAULT 0,
    "taskRunId" TEXT NOT NULL,
    "backgroundWorkerId" TEXT NOT NULL,
    "backgroundWorkerTaskId" TEXT NOT NULL,
    "status" "TaskRunAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "output" TEXT,
    "outputType" TEXT NOT NULL DEFAULT 'application/json',

    CONSTRAINT "TaskRunAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_TaskRunToTaskTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskTag_projectId_name_key" ON "TaskTag"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunAttempt_taskRunId_number_key" ON "TaskRunAttempt"("taskRunId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "_TaskRunToTaskTag_AB_unique" ON "_TaskRunToTaskTag"("A", "B");

-- CreateIndex
CREATE INDEX "_TaskRunToTaskTag_B_index" ON "_TaskRunToTaskTag"("B");

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "BackgroundWorkerTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTag" ADD CONSTRAINT "TaskTag_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunAttempt" ADD CONSTRAINT "TaskRunAttempt_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunAttempt" ADD CONSTRAINT "TaskRunAttempt_backgroundWorkerId_fkey" FOREIGN KEY ("backgroundWorkerId") REFERENCES "BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunAttempt" ADD CONSTRAINT "TaskRunAttempt_backgroundWorkerTaskId_fkey" FOREIGN KEY ("backgroundWorkerTaskId") REFERENCES "BackgroundWorkerTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TaskRunToTaskTag" ADD CONSTRAINT "_TaskRunToTaskTag_A_fkey" FOREIGN KEY ("A") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TaskRunToTaskTag" ADD CONSTRAINT "_TaskRunToTaskTag_B_fkey" FOREIGN KEY ("B") REFERENCES "TaskTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
