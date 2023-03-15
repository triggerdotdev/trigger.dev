/*
  Warnings:

  - A unique constraint covering the columns `[projectId,version]` on the table `ProjectDeployment` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `version` to the `ProjectDeployment` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "ProjectDeployment_projectId_commitHash_key";

-- AlterTable
ALTER TABLE "ProjectDeployment" ADD COLUMN     "version" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDeployment_projectId_version_key" ON "ProjectDeployment"("projectId", "version");
