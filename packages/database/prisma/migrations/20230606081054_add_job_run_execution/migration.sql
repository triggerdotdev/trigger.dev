-- CreateEnum
CREATE TYPE "JobRunExecutionReason" AS ENUM ('INITIAL', 'RETRY', 'RESUME');

-- CreateEnum
CREATE TYPE "JobRunExecutionStatus" AS ENUM ('PENDING', 'STARTED', 'SUCCESS', 'FAILURE');

-- CreateTable
CREATE TABLE "JobRunExecution" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "responseStatus" INTEGER,
    "responseHeaders" JSONB,
    "responseBody" TEXT,
    "reason" "JobRunExecutionReason" NOT NULL DEFAULT 'INITIAL',
    "status" "JobRunExecutionStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "JobRunExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobRunExecution_runId_number_key" ON "JobRunExecution"("runId", "number");

-- AddForeignKey
ALTER TABLE "JobRunExecution" ADD CONSTRAINT "JobRunExecution_runId_fkey" FOREIGN KEY ("runId") REFERENCES "JobRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
