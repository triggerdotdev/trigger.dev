-- CreateTable
CREATE TABLE "DurableDelay" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "delayUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "DurableDelay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DurableDelay_stepId_key" ON "DurableDelay"("stepId");

-- AddForeignKey
ALTER TABLE "DurableDelay" ADD CONSTRAINT "DurableDelay_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DurableDelay" ADD CONSTRAINT "DurableDelay_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "WorkflowRunStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
