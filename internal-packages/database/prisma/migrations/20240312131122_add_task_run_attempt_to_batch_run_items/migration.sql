-- AlterTable
ALTER TABLE "BatchTaskRunItem" ADD COLUMN     "taskRunAttemptId" TEXT;

-- AddForeignKey
ALTER TABLE "BatchTaskRunItem" ADD CONSTRAINT "BatchTaskRunItem_taskRunAttemptId_fkey" FOREIGN KEY ("taskRunAttemptId") REFERENCES "TaskRunAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
