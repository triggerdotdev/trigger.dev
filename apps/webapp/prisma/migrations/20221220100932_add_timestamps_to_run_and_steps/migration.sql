/*
  Warnings:

  - You are about to drop the column `timestamp` on the `WorkflowRun` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "WorkflowRun" DROP COLUMN "timestamp",
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "WorkflowRunStep" ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
