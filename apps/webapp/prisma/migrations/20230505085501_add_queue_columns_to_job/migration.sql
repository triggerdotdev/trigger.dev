-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "maxConcurrentRuns" INTEGER,
ADD COLUMN     "queueName" TEXT;
