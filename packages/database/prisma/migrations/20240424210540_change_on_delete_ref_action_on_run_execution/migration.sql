-- DropForeignKey
ALTER TABLE "JobRunExecution" DROP CONSTRAINT "JobRunExecution_resumeTaskId_fkey";

-- AddForeignKey
ALTER TABLE "JobRunExecution" ADD CONSTRAINT "JobRunExecution_resumeTaskId_fkey" FOREIGN KEY ("resumeTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
