-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "parentTaskRunAttemptId" TEXT,
ADD COLUMN     "parentTaskRunId" TEXT,
ADD COLUMN     "resumeParentOnCompletion" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "TaskRun_parentTaskRunId_idx" ON "TaskRun"("parentTaskRunId");

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_parentTaskRunId_fkey" FOREIGN KEY ("parentTaskRunId") REFERENCES "TaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_parentTaskRunAttemptId_fkey" FOREIGN KEY ("parentTaskRunAttemptId") REFERENCES "TaskRunAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BatchTaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
