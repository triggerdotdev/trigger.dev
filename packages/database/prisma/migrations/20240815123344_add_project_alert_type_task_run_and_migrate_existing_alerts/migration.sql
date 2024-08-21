-- AlterEnum
ALTER TYPE "ProjectAlertType" ADD VALUE 'TASK_RUN';

-- AlterTable
ALTER TABLE "ProjectAlert"
ADD COLUMN "taskRunId" TEXT;

-- AddForeignKey
ALTER TABLE "ProjectAlert" ADD CONSTRAINT "ProjectAlert_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "TaskRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE;