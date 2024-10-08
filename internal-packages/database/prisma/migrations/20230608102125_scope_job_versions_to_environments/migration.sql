/*
  Warnings:

  - A unique constraint covering the columns `[jobId,version,environmentId]` on the table `JobVersion` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "JobVersion_jobId_version_endpointId_key";

-- CreateIndex
CREATE UNIQUE INDEX "JobVersion_jobId_version_environmentId_key" ON "JobVersion"("jobId", "version", "environmentId");
