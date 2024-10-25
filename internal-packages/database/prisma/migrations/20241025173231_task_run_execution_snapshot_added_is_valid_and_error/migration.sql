-- DropIndex
DROP INDEX "TaskRunExecutionSnapshot_runId_createdAt_idx";

-- AlterTable
ALTER TABLE "TaskRunExecutionSnapshot" ADD COLUMN     "error" TEXT,
ADD COLUMN     "isValid" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "TaskRunExecutionSnapshot_runId_isValid_createdAt_idx" ON "TaskRunExecutionSnapshot"("runId", "isValid", "createdAt" DESC);
