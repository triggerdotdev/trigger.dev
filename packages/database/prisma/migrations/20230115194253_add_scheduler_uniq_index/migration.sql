/*
  Warnings:

  - A unique constraint covering the columns `[workflowId,environmentId]` on the table `SchedulerSource` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "SchedulerSource_workflowId_environmentId_key" ON "SchedulerSource"("workflowId", "environmentId");
