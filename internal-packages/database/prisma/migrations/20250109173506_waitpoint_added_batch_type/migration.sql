-- AlterEnum
ALTER TYPE "WaitpointType" ADD VALUE 'BATCH';

-- AlterTable
ALTER TABLE "Waitpoint" ADD COLUMN     "completedByBatchId" TEXT;

-- AddForeignKey
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_completedByBatchId_fkey" FOREIGN KEY ("completedByBatchId") REFERENCES "BatchTaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
