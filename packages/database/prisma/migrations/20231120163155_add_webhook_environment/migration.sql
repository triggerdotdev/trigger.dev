/*
  Warnings:

  - You are about to drop the column `config` on the `Webhook` table. All the data in the column will be lost.
  - You are about to drop the column `desiredConfig` on the `Webhook` table. All the data in the column will be lost.
  - You are about to drop the column `environmentId` on the `Webhook` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Webhook" DROP CONSTRAINT "Webhook_environmentId_fkey";

-- AlterTable
ALTER TABLE "Webhook" DROP COLUMN "config",
DROP COLUMN "desiredConfig",
DROP COLUMN "environmentId";

-- CreateTable
CREATE TABLE "WebhookEnvironment" (
    "id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "desiredConfig" JSONB,
    "environmentId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEnvironment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEnvironment_environmentId_webhookId_key" ON "WebhookEnvironment"("environmentId", "webhookId");

-- AddForeignKey
ALTER TABLE "WebhookEnvironment" ADD CONSTRAINT "WebhookEnvironment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEnvironment" ADD CONSTRAINT "WebhookEnvironment_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
