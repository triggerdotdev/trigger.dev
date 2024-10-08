-- AlterTable
ALTER TABLE "JobRunExecution" ADD COLUMN     "resumeTaskId" TEXT;

-- AddForeignKey
ALTER TABLE "JobRunExecution" ADD CONSTRAINT "JobRunExecution_resumeTaskId_fkey" FOREIGN KEY ("resumeTaskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
