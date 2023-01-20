-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN     "timedOutAt" TIMESTAMP(3),
ADD COLUMN     "timedOutReason" TEXT;
