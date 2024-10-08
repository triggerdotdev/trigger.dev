-- AlterTable
ALTER TABLE "WorkerDeployment" ADD COLUMN     "errorData" JSONB,
ADD COLUMN     "failedAt" TIMESTAMP(3);
