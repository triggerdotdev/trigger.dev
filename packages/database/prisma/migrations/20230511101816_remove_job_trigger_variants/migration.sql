/*
  Warnings:

  - You are about to drop the `JobTriggerVariant` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "JobTriggerVariant" DROP CONSTRAINT "JobTriggerVariant_eventRuleId_fkey";

-- DropForeignKey
ALTER TABLE "JobTriggerVariant" DROP CONSTRAINT "JobTriggerVariant_jobInstanceId_fkey";

-- DropTable
DROP TABLE "JobTriggerVariant";
