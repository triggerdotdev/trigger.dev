-- CreateTable
CREATE TABLE "JobTriggerVariant" (
    "id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "jobInstanceId" TEXT NOT NULL,
    "eventRuleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobTriggerVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobTriggerVariant_eventRuleId_key" ON "JobTriggerVariant"("eventRuleId");

-- AddForeignKey
ALTER TABLE "JobTriggerVariant" ADD CONSTRAINT "JobTriggerVariant_jobInstanceId_fkey" FOREIGN KEY ("jobInstanceId") REFERENCES "JobInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTriggerVariant" ADD CONSTRAINT "JobTriggerVariant_eventRuleId_fkey" FOREIGN KEY ("eventRuleId") REFERENCES "JobEventRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
