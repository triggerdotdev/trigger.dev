/*
  Warnings:

  - A unique constraint covering the columns `[jobInstanceId,taskId]` on the table `JobEventRule` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "JobEventRule_jobInstanceId_key";

-- CreateIndex
CREATE UNIQUE INDEX "JobEventRule_jobInstanceId_taskId_key" ON "JobEventRule"("jobInstanceId", "taskId");
