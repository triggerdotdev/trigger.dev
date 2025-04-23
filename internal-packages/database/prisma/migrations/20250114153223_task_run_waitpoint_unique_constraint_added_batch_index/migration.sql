/*
  Warnings:

  - A unique constraint covering the columns `[taskRunId,waitpointId,batchIndex]` on the table `TaskRunWaitpoint` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "TaskRunWaitpoint_taskRunId_waitpointId_key";

-- CreateIndex (multiple can have null batchIndex, so we need the other one below)
CREATE UNIQUE INDEX "TaskRunWaitpoint_taskRunId_waitpointId_batchIndex_key" ON "TaskRunWaitpoint" ("taskRunId", "waitpointId", "batchIndex");

-- CreateIndex (where batchIndex is null)
CREATE UNIQUE INDEX "TaskRunWaitpoint_taskRunId_waitpointId_batchIndex_null_key" ON "TaskRunWaitpoint"("taskRunId", "waitpointId") WHERE "batchIndex" IS NULL;
