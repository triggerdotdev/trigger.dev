-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."BatchTaskRunStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "public"."BatchTaskRunStatus" ADD VALUE 'PARTIAL_FAILED';

-- AlterTable
ALTER TABLE "public"."BatchTaskRun" ADD COLUMN     "failedRunCount" INTEGER,
ADD COLUMN     "processingStartedAt" TIMESTAMP(3),
ADD COLUMN     "successfulRunCount" INTEGER;

-- CreateTable
CREATE TABLE "public"."BatchTaskRunError" (
    "id" TEXT NOT NULL,
    "batchTaskRunId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "taskIdentifier" TEXT NOT NULL,
    "payload" TEXT,
    "options" JSONB,
    "error" TEXT NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatchTaskRunError_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BatchTaskRunError_batchTaskRunId_idx" ON "public"."BatchTaskRunError"("batchTaskRunId");

-- AddForeignKey
ALTER TABLE "public"."BatchTaskRunError" ADD CONSTRAINT "BatchTaskRunError_batchTaskRunId_fkey" FOREIGN KEY ("batchTaskRunId") REFERENCES "public"."BatchTaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
