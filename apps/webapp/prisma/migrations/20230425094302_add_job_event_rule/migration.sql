-- AlterTable
ALTER TABLE "EventLog" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'trigger.dev';

-- CreateTable
CREATE TABLE "JobEventRule" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payloadFilter" JSONB,
    "contextFilter" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "jobId" TEXT NOT NULL,
    "jobInstanceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,

    CONSTRAINT "JobEventRule_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "JobEventRule" ADD CONSTRAINT "JobEventRule_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEventRule" ADD CONSTRAINT "JobEventRule_jobInstanceId_fkey" FOREIGN KEY ("jobInstanceId") REFERENCES "JobInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEventRule" ADD CONSTRAINT "JobEventRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEventRule" ADD CONSTRAINT "JobEventRule_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
