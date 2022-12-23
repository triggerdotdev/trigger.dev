/*
  Warnings:

  - You are about to drop the column `triggerId` on the `WorkflowRun` table. All the data in the column will be lost.
  - You are about to drop the `RegisteredWebhook` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WorkflowConnectionSlot` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WorkflowTrigger` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `filter` to the `Workflow` table without a default value. This is not possible if the table is not empty.
  - Added the required column `subscription` to the `Workflow` table without a default value. This is not possible if the table is not empty.
  - Added the required column `type` to the `Workflow` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "SubscriptionType" AS ENUM ('WEBHOOK', 'SCHEDULE', 'CUSTOM_EVENT', 'HTTP_ENDPOINT', 'EVENT_BRIDGE', 'HTTP_POLLING');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('CREATED', 'READY');

-- CreateEnum
CREATE TYPE "ExternalSourceStatus" AS ENUM ('CREATED', 'READY');

-- CreateEnum
CREATE TYPE "ExternalSourceType" AS ENUM ('WEBHOOK', 'EVENT_BRIDGE', 'HTTP_POLLING');

-- DropForeignKey
ALTER TABLE "RegisteredWebhook" DROP CONSTRAINT "RegisteredWebhook_connectionSlotId_fkey";

-- DropForeignKey
ALTER TABLE "RegisteredWebhook" DROP CONSTRAINT "RegisteredWebhook_triggerId_fkey";

-- DropForeignKey
ALTER TABLE "RegisteredWebhook" DROP CONSTRAINT "RegisteredWebhook_workflowId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowConnectionSlot" DROP CONSTRAINT "WorkflowConnectionSlot_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowConnectionSlot" DROP CONSTRAINT "WorkflowConnectionSlot_triggerId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowConnectionSlot" DROP CONSTRAINT "WorkflowConnectionSlot_workflowId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowRun" DROP CONSTRAINT "WorkflowRun_triggerId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowTrigger" DROP CONSTRAINT "WorkflowTrigger_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowTrigger" DROP CONSTRAINT "WorkflowTrigger_workflowId_fkey";

-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "externalSourceId" TEXT,
ADD COLUMN     "filter" JSONB NOT NULL,
ADD COLUMN     "status" "SubscriptionStatus" NOT NULL DEFAULT 'CREATED',
ADD COLUMN     "subscription" JSONB NOT NULL,
ADD COLUMN     "type" "SubscriptionType" NOT NULL;

-- AlterTable
ALTER TABLE "WorkflowRun" DROP COLUMN "triggerId";

-- DropTable
DROP TABLE "RegisteredWebhook";

-- DropTable
DROP TABLE "WorkflowConnectionSlot";

-- DropTable
DROP TABLE "WorkflowTrigger";

-- DropEnum
DROP TYPE "WorkflowTriggerStatus";

-- DropEnum
DROP TYPE "WorkflowTriggerType";

-- CreateTable
CREATE TABLE "ExternalSource" (
    "id" TEXT NOT NULL,
    "type" "ExternalSourceType" NOT NULL,
    "source" JSONB NOT NULL,
    "status" "ExternalSourceStatus" NOT NULL DEFAULT 'CREATED',
    "externalData" JSONB,
    "readyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "connectionId" TEXT,

    CONSTRAINT "ExternalSource_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_externalSourceId_fkey" FOREIGN KEY ("externalSourceId") REFERENCES "ExternalSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalSource" ADD CONSTRAINT "ExternalSource_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "APIConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
