/*
  Warnings:

  - A unique constraint covering the columns `[friendlyId]` on the table `BackgroundWorker` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[friendlyId]` on the table `BackgroundWorkerTask` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[friendlyId]` on the table `TaskRun` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[friendlyId]` on the table `TaskRunAttempt` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[friendlyId]` on the table `TaskTag` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `friendlyId` to the `BackgroundWorker` table without a default value. This is not possible if the table is not empty.
  - Added the required column `friendlyId` to the `BackgroundWorkerTask` table without a default value. This is not possible if the table is not empty.
  - Added the required column `friendlyId` to the `TaskRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `friendlyId` to the `TaskRunAttempt` table without a default value. This is not possible if the table is not empty.
  - Added the required column `friendlyId` to the `TaskTag` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "BackgroundWorker" ADD COLUMN     "friendlyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "BackgroundWorkerTask" ADD COLUMN     "friendlyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "friendlyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "TaskRunAttempt" ADD COLUMN     "friendlyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "TaskTag" ADD COLUMN     "friendlyId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundWorker_friendlyId_key" ON "BackgroundWorker"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundWorkerTask_friendlyId_key" ON "BackgroundWorkerTask"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRun_friendlyId_key" ON "TaskRun"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunAttempt_friendlyId_key" ON "TaskRunAttempt"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskTag_friendlyId_key" ON "TaskTag"("friendlyId");
