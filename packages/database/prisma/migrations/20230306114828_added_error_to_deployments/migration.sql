/*
  Warnings:

  - A unique constraint covering the columns `[projectId,commitHash]` on the table `ProjectDeployment` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "ProjectDeployment" ADD COLUMN     "error" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDeployment_projectId_commitHash_key" ON "ProjectDeployment"("projectId", "commitHash");
