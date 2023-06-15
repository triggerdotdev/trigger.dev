/*
  Warnings:

  - Added the required column `nextPollScheduledAt` to the `DeploymentLogPoll` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "DeploymentLogPoll" ADD COLUMN     "nextPollScheduledAt" TIMESTAMP(3) NOT NULL;
