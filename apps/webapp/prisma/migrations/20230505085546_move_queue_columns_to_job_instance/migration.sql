/*
  Warnings:

  - You are about to drop the column `maxConcurrentRuns` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `queueName` on the `Job` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Job" DROP COLUMN "maxConcurrentRuns",
DROP COLUMN "queueName";

-- AlterTable
ALTER TABLE "JobInstance" ADD COLUMN     "maxConcurrentRuns" INTEGER,
ADD COLUMN     "queueName" TEXT;
