/*
  Warnings:

  - A unique constraint covering the columns `[projectId,runtimeEnvironmentId,contentHash]` on the table `ImageDetails` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "ImageDetails_projectId_runtimeEnvironmentId_tag_key";

-- CreateIndex
CREATE UNIQUE INDEX "ImageDetails_projectId_runtimeEnvironmentId_contentHash_key" ON "ImageDetails"("projectId", "runtimeEnvironmentId", "contentHash");
