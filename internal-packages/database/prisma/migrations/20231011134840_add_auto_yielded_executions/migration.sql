-- CreateTable
CREATE TABLE "JobRunAutoYieldExecution" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "timeRemaining" INTEGER NOT NULL,
    "timeElapsed" INTEGER NOT NULL,
    "limit" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobRunAutoYieldExecution_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "JobRunAutoYieldExecution" ADD CONSTRAINT "JobRunAutoYieldExecution_runId_fkey" FOREIGN KEY ("runId") REFERENCES "JobRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
