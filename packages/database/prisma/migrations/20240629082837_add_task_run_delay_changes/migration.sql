-- AlterEnum
ALTER TYPE "TaskRunStatus" ADD VALUE 'DELAYED';

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "delayUntil" TIMESTAMP(3),
ADD COLUMN     "queuedAt" TIMESTAMP(3);
