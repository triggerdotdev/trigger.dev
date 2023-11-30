/*
  Warnings:

  - You are about to drop the column `concurrencyLimitGroupId` on the `JobRun` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "JobRun" DROP CONSTRAINT "JobRun_concurrencyLimitGroupId_fkey";

-- AlterTable
ALTER TABLE "JobRun" DROP COLUMN "concurrencyLimitGroupId";
