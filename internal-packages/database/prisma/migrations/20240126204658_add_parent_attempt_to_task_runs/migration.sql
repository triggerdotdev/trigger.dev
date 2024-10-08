-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "parentAttemptId" TEXT;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_parentAttemptId_fkey" FOREIGN KEY ("parentAttemptId") REFERENCES "TaskRunAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
