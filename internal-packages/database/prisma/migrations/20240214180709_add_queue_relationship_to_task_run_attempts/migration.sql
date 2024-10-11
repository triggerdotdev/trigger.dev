/*
  Warnings:

  - Added the required column `queueId` to the `TaskRunAttempt` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TaskRunAttempt" ADD COLUMN     "queueId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "TaskRunAttempt" ADD CONSTRAINT "TaskRunAttempt_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "TaskQueue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
