/*
  Warnings:

  - Added the required column `pollNumber` to the `DeploymentLogPoll` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "DeploymentLogPoll" ADD COLUMN     "pollNumber" INTEGER NOT NULL;
