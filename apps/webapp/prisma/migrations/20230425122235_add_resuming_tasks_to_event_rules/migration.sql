-- CreateEnum
CREATE TYPE "JobEventAction" AS ENUM ('CREATE_EXECUTION', 'RESUME_TASK');

-- AlterTable
ALTER TABLE "JobEventRule" ADD COLUMN     "action" "JobEventAction" NOT NULL DEFAULT 'CREATE_EXECUTION',
ADD COLUMN     "taskId" TEXT;

-- AddForeignKey
ALTER TABLE "JobEventRule" ADD CONSTRAINT "JobEventRule_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
