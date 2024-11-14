/*
  Warnings:

  - A unique constraint covering the columns `[friendlyId]` on the table `Waitpoint` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `friendlyId` to the `Waitpoint` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "priorityMs" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Waitpoint" ADD COLUMN     "friendlyId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_friendlyId_key" ON "Waitpoint"("friendlyId");
