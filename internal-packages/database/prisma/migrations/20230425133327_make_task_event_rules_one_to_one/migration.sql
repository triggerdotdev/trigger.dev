/*
  Warnings:

  - A unique constraint covering the columns `[taskId]` on the table `JobEventRule` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "JobEventRule_taskId_key" ON "JobEventRule"("taskId");
