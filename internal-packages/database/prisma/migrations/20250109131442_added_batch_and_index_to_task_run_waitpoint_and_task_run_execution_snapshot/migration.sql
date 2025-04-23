-- AlterTable
ALTER TABLE "TaskRunExecutionSnapshot" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "completedWaitpointOrder" TEXT[];

-- AlterTable
ALTER TABLE "TaskRunWaitpoint" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "batchIndex" INTEGER;

-- AddForeignKey
ALTER TABLE "TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BatchTaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunWaitpoint" ADD CONSTRAINT "TaskRunWaitpoint_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BatchTaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
