-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "metadata" TEXT,
ADD COLUMN     "metadataType" TEXT NOT NULL DEFAULT 'application/json',
ADD COLUMN     "output" TEXT,
ADD COLUMN     "outputType" TEXT NOT NULL DEFAULT 'application/json';
