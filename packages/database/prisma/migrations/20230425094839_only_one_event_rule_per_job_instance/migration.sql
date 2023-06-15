/*
  Warnings:

  - A unique constraint covering the columns `[jobInstanceId]` on the table `JobEventRule` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "JobEventRule_jobInstanceId_key" ON "JobEventRule"("jobInstanceId");
