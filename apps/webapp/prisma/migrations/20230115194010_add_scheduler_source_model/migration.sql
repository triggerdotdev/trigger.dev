/*
  Warnings:

  - The values [SCHEDULER] on the enum `ExternalSourceType` will be removed. If these variants are still used in the database, this will fail.

*/
-- CreateEnum
CREATE TYPE "SchedulerSourceStatus" AS ENUM ('CREATED', 'READY', 'CANCELLED');

-- AlterEnum
BEGIN;
CREATE TYPE "ExternalSourceType_new" AS ENUM ('WEBHOOK', 'EVENT_BRIDGE', 'HTTP_POLLING');
ALTER TABLE "ExternalSource" ALTER COLUMN "type" TYPE "ExternalSourceType_new" USING ("type"::text::"ExternalSourceType_new");
ALTER TYPE "ExternalSourceType" RENAME TO "ExternalSourceType_old";
ALTER TYPE "ExternalSourceType_new" RENAME TO "ExternalSourceType";
DROP TYPE "ExternalSourceType_old";
COMMIT;

-- CreateTable
CREATE TABLE "SchedulerSource" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "status" "SchedulerSourceStatus" NOT NULL DEFAULT 'CREATED',
    "readyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchedulerSource_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "SchedulerSource" ADD CONSTRAINT "SchedulerSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchedulerSource" ADD CONSTRAINT "SchedulerSource_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchedulerSource" ADD CONSTRAINT "SchedulerSource_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
