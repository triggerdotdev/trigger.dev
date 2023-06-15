/*
  Warnings:

  - Added the required column `eventRuleId` to the `WorkflowRun` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN     "eventRuleId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_eventRuleId_fkey" FOREIGN KEY ("eventRuleId") REFERENCES "EventRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
