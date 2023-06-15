/*
  Warnings:

  - A unique constraint covering the columns `[projectId,slug]` on the table `Job` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Job_organizationId_slug_key";

-- CreateIndex
CREATE UNIQUE INDEX "Job_projectId_slug_key" ON "Job"("projectId", "slug");
