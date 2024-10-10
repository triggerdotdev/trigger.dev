-- AlterTable
ALTER TABLE "TriggerSource" ADD COLUMN     "dynamicSourceId" TEXT,
ADD COLUMN     "dynamicSourceMetadata" JSONB;
