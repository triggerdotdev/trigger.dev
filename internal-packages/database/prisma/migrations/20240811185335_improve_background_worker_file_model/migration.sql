/*
  Warnings:

  - You are about to drop the column `backgroundWorkerId` on the `BackgroundWorkerFile` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[projectId,contentHash]` on the table `BackgroundWorkerFile` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `projectId` to the `BackgroundWorkerFile` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "BackgroundWorkerFile" DROP CONSTRAINT "BackgroundWorkerFile_backgroundWorkerId_fkey";

-- AlterTable
ALTER TABLE "BackgroundWorkerFile" DROP COLUMN "backgroundWorkerId",
ADD COLUMN     "projectId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "_BackgroundWorkerToBackgroundWorkerFile" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "_BackgroundWorkerToBackgroundWorkerFile_AB_unique" ON "_BackgroundWorkerToBackgroundWorkerFile"("A", "B");

-- CreateIndex
CREATE INDEX "_BackgroundWorkerToBackgroundWorkerFile_B_index" ON "_BackgroundWorkerToBackgroundWorkerFile"("B");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundWorkerFile_projectId_contentHash_key" ON "BackgroundWorkerFile"("projectId", "contentHash");

-- AddForeignKey
ALTER TABLE "BackgroundWorkerFile" ADD CONSTRAINT "BackgroundWorkerFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BackgroundWorkerToBackgroundWorkerFile" ADD CONSTRAINT "_BackgroundWorkerToBackgroundWorkerFile_A_fkey" FOREIGN KEY ("A") REFERENCES "BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BackgroundWorkerToBackgroundWorkerFile" ADD CONSTRAINT "_BackgroundWorkerToBackgroundWorkerFile_B_fkey" FOREIGN KEY ("B") REFERENCES "BackgroundWorkerFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
