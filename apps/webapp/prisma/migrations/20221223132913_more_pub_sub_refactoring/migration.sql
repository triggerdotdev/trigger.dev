/*
  Warnings:

  - You are about to drop the column `filter` on the `Workflow` table. All the data in the column will be lost.
  - You are about to drop the column `subscription` on the `Workflow` table. All the data in the column will be lost.
  - The `status` column on the `Workflow` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `context` on the `WorkflowRun` table. All the data in the column will be lost.
  - You are about to drop the column `input` on the `WorkflowRun` table. All the data in the column will be lost.
  - You are about to drop the `CustomEvent` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `eventRule` to the `Workflow` table without a default value. This is not possible if the table is not empty.
  - Added the required column `trigger` to the `Workflow` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `type` on the `Workflow` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `eventId` to the `WorkflowRun` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "TriggerType" AS ENUM ('WEBHOOK', 'SCHEDULE', 'CUSTOM_EVENT', 'HTTP_ENDPOINT', 'EVENT_BRIDGE', 'HTTP_POLLING');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('CREATED', 'READY');

-- CreateEnum
CREATE TYPE "TriggerEventStatus" AS ENUM ('PENDING', 'PROCESSED');

-- DropForeignKey
ALTER TABLE "CustomEvent" DROP CONSTRAINT "CustomEvent_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "CustomEvent" DROP CONSTRAINT "CustomEvent_organizationId_fkey";

-- AlterTable
ALTER TABLE "Workflow" DROP COLUMN "filter",
DROP COLUMN "subscription",
ADD COLUMN     "eventRule" JSONB NOT NULL,
ADD COLUMN     "trigger" JSONB NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "WorkflowStatus" NOT NULL DEFAULT 'CREATED',
DROP COLUMN "type",
ADD COLUMN     "type" "TriggerType" NOT NULL;

-- AlterTable
ALTER TABLE "WorkflowRun" DROP COLUMN "context",
DROP COLUMN "input",
ADD COLUMN     "eventId" TEXT NOT NULL;

-- DropTable
DROP TABLE "CustomEvent";

-- DropEnum
DROP TYPE "CustomEventStatus";

-- DropEnum
DROP TYPE "RegisteredWebhookStatus";

-- DropEnum
DROP TYPE "SubscriptionStatus";

-- DropEnum
DROP TYPE "SubscriptionType";

-- CreateTable
CREATE TABLE "TriggerEvent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TriggerType" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "context" JSONB,
    "organizationId" TEXT,
    "environmentId" TEXT,
    "status" "TriggerEventStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "TriggerEvent_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "TriggerEvent" ADD CONSTRAINT "TriggerEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerEvent" ADD CONSTRAINT "TriggerEvent_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "TriggerEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
