-- AlterTable
ALTER TABLE "BatchTaskRun" ADD COLUMN     "processingJobsCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "processingJobsExpectedCount" INTEGER NOT NULL DEFAULT 0;
