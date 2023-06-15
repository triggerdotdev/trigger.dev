/*
  Warnings:

  - You are about to drop the column `taskId` on the `JobEventRule` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[actionIdentifier]` on the table `JobEventRule` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[jobInstanceId,actionIdentifier]` on the table `JobEventRule` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `actionIdentifier` to the `JobEventRule` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "JobEventRule" DROP CONSTRAINT "JobEventRule_taskId_fkey";

-- DropIndex
DROP INDEX "JobEventRule_jobInstanceId_taskId_key";

-- DropIndex
DROP INDEX "JobEventRule_taskId_key";

-- AlterTable
ALTER TABLE "JobEventRule" DROP COLUMN "taskId",
ADD COLUMN     "actionIdentifier" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "JobEventRule_actionIdentifier_key" ON "JobEventRule"("actionIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "JobEventRule_jobInstanceId_actionIdentifier_key" ON "JobEventRule"("jobInstanceId", "actionIdentifier");
