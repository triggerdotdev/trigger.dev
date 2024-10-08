/*
  Warnings:

  - You are about to drop the column `queueId` on the `TaskRun` table. All the data in the column will be lost.
  - Added the required column `queue` to the `TaskRun` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "TaskRun" DROP CONSTRAINT "TaskRun_queueId_fkey";

-- AlterTable
ALTER TABLE "TaskRun" DROP COLUMN "queueId",
ADD COLUMN     "queue" TEXT NOT NULL;
