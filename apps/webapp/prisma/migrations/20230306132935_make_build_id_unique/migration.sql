/*
  Warnings:

  - A unique constraint covering the columns `[buildId]` on the table `ProjectDeployment` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ProjectDeployment_buildId_key" ON "ProjectDeployment"("buildId");
