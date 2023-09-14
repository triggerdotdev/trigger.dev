/*
  Warnings:

  - A unique constraint covering the columns `[backgroundTaskArtifactId,digest]` on the table `BackgroundTaskImage` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "BackgroundTaskImage_backgroundTaskArtifactId_digest_key" ON "BackgroundTaskImage"("backgroundTaskArtifactId", "digest");
