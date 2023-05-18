/*
  Warnings:

  - You are about to drop the `JobTrigger` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "JobTrigger" DROP CONSTRAINT "JobTrigger_dynamicTriggerId_fkey";

-- DropForeignKey
ALTER TABLE "JobTrigger" DROP CONSTRAINT "JobTrigger_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "JobTrigger" DROP CONSTRAINT "JobTrigger_externalAccountId_fkey";

-- DropForeignKey
ALTER TABLE "JobTrigger" DROP CONSTRAINT "JobTrigger_jobId_fkey";

-- DropForeignKey
ALTER TABLE "JobTrigger" DROP CONSTRAINT "JobTrigger_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "JobTrigger" DROP CONSTRAINT "JobTrigger_projectId_fkey";

-- DropForeignKey
ALTER TABLE "JobTrigger" DROP CONSTRAINT "JobTrigger_versionId_fkey";

-- DropTable
DROP TABLE "JobTrigger";

-- DropEnum
DROP TYPE "JobTriggerAction";

-- CreateTable
CREATE TABLE "EventDispatcher" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payloadFilter" JSONB,
    "contextFilter" JSONB,
    "dispatchableId" TEXT NOT NULL,
    "dispatchable" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "environmentId" TEXT NOT NULL,

    CONSTRAINT "EventDispatcher_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventDispatcher_dispatchableId_environmentId_key" ON "EventDispatcher"("dispatchableId", "environmentId");

-- AddForeignKey
ALTER TABLE "EventDispatcher" ADD CONSTRAINT "EventDispatcher_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
