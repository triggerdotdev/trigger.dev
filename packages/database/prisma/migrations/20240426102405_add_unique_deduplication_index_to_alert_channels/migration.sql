/*
  Warnings:

  - A unique constraint covering the columns `[projectId,deduplicationKey]` on the table `ProjectAlertChannel` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ProjectAlertChannel_projectId_deduplicationKey_key" ON "ProjectAlertChannel"("projectId", "deduplicationKey");
