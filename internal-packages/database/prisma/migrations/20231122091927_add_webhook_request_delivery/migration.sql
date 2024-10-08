/*
  Warnings:

  - Added the required column `endpointId` to the `WebhookEnvironment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "WebhookEnvironment" ADD COLUMN     "endpointId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "WebhookRequestDelivery" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "headers" JSONB NOT NULL,
    "body" BYTEA,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "webhookId" TEXT NOT NULL,
    "webhookEnvironmentId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "WebhookRequestDelivery_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "WebhookEnvironment" ADD CONSTRAINT "WebhookEnvironment_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookRequestDelivery" ADD CONSTRAINT "WebhookRequestDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookRequestDelivery" ADD CONSTRAINT "WebhookRequestDelivery_webhookEnvironmentId_fkey" FOREIGN KEY ("webhookEnvironmentId") REFERENCES "WebhookEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookRequestDelivery" ADD CONSTRAINT "WebhookRequestDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
