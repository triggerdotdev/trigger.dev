/*
  Warnings:

  - A unique constraint covering the columns `[taskId]` on the table `BackgroundTaskOperation` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `taskId` to the `BackgroundTaskOperation` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "BackgroundTaskOperation" ADD COLUMN     "taskId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundTaskOperation_taskId_key" ON "BackgroundTaskOperation"("taskId");

-- AddForeignKey
ALTER TABLE "BackgroundTaskOperation" ADD CONSTRAINT "BackgroundTaskOperation_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
