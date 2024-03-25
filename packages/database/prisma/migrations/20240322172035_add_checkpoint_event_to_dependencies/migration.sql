/*
  Warnings:

  - A unique constraint covering the columns `[checkpointEventId]` on the table `BatchTaskRun` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[checkpointEventId]` on the table `TaskRunDependency` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "BatchTaskRun" ADD COLUMN     "checkpointEventId" TEXT;

-- AlterTable
ALTER TABLE "TaskRunDependency" ADD COLUMN     "checkpointEventId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_checkpointEventId_key" ON "BatchTaskRun"("checkpointEventId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunDependency_checkpointEventId_key" ON "TaskRunDependency"("checkpointEventId");

-- AddForeignKey
ALTER TABLE "TaskRunDependency" ADD CONSTRAINT "TaskRunDependency_checkpointEventId_fkey" FOREIGN KEY ("checkpointEventId") REFERENCES "CheckpointRestoreEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchTaskRun" ADD CONSTRAINT "BatchTaskRun_checkpointEventId_fkey" FOREIGN KEY ("checkpointEventId") REFERENCES "CheckpointRestoreEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
