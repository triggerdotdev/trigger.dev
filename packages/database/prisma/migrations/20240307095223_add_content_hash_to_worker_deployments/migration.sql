/*
  Warnings:

  - Added the required column `contentHash` to the `WorkerDeployment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "WorkerDeployment" ADD COLUMN     "contentHash" TEXT NOT NULL;
