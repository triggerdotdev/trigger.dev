/*
  Warnings:

  - You are about to drop the column `firstAttemptStartedAt` on the `TaskRun` table. All the data in the column will be lost.

*/

-- AlterTable
ALTER TABLE "TaskRun" DROP COLUMN "firstAttemptStartedAt";
