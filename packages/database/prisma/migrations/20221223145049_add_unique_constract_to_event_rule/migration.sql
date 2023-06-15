/*
  Warnings:

  - A unique constraint covering the columns `[workflowId,environmentId]` on the table `EventRule` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "EventRule_workflowId_environmentId_key" ON "EventRule"("workflowId", "environmentId");
