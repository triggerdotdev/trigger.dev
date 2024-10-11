-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "seedMetadata" TEXT,
ADD COLUMN     "seedMetadataType" TEXT NOT NULL DEFAULT 'application/json';
