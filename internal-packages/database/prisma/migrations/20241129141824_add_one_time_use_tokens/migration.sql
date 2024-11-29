-- AlterTable
ALTER TABLE "BatchTaskRun" ADD COLUMN     "oneTimeUseToken" TEXT;

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "oneTimeUseToken" TEXT;
