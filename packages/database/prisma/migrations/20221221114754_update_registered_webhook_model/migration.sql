/*
  Warnings:

  - You are about to drop the column `isEnabled` on the `RegisteredWebhook` table. All the data in the column will be lost.
  - Added the required column `updatedAt` to the `RegisteredWebhook` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "RegisteredWebhookStatus" AS ENUM ('CREATED', 'CONNECTED');

-- DropIndex
DROP INDEX "RegisteredWebhook_workflowId_triggerId_key";

-- AlterTable
ALTER TABLE "RegisteredWebhook" DROP COLUMN "isEnabled",
ADD COLUMN     "connectedAt" TIMESTAMP(3),
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "status" "RegisteredWebhookStatus" NOT NULL DEFAULT 'CREATED',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "webhookConfig" DROP NOT NULL;
