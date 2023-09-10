-- AlterTable
ALTER TABLE "JobRun" ADD COLUMN     "executionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "executionDuration" INTEGER NOT NULL DEFAULT 0;
