-- AlterTable
ALTER TABLE "BatchTaskRun" ADD COLUMN     "payload" TEXT,
ADD COLUMN     "payloadType" TEXT NOT NULL DEFAULT 'application/json';
