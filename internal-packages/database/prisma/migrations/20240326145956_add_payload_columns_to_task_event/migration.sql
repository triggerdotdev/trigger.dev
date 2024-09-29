-- AlterTable
ALTER TABLE "TaskEvent" ADD COLUMN     "payload" JSONB,
ADD COLUMN     "payloadType" TEXT;
