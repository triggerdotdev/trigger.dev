-- AlterTable
ALTER TABLE "TaskEvent" ADD COLUMN     "usageDurationMs" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "usageDurationMs" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TaskRunAttempt" ADD COLUMN     "usageDurationMs" INTEGER NOT NULL DEFAULT 0;
