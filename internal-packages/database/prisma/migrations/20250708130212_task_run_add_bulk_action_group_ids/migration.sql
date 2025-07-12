-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "bulkActionGroupIds" TEXT[] DEFAULT ARRAY[]::TEXT[];