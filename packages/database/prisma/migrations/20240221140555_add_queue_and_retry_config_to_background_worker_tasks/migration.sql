-- AlterTable
ALTER TABLE "BackgroundWorkerTask" ADD COLUMN     "queueConfig" JSONB,
ADD COLUMN     "retryConfig" JSONB;
