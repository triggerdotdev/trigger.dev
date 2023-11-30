-- AlterTable
ALTER TABLE "JobRun" ADD COLUMN     "batched" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "eventIds" TEXT[];

-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN     "batched" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "WebhookDeliveryBatcher" (
    "id" TEXT NOT NULL,
    "maxPayloads" INTEGER,
    "maxInterval" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "webhookId" TEXT NOT NULL,
    "webhookEnvironmentId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,

    CONSTRAINT "WebhookDeliveryBatcher_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDeliveryBatcher_webhookEnvironmentId_key" ON "WebhookDeliveryBatcher"("webhookEnvironmentId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDeliveryBatcher_webhookId_webhookEnvironmentId_key" ON "WebhookDeliveryBatcher"("webhookId", "webhookEnvironmentId");

-- AddForeignKey
ALTER TABLE "WebhookDeliveryBatcher" ADD CONSTRAINT "WebhookDeliveryBatcher_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDeliveryBatcher" ADD CONSTRAINT "WebhookDeliveryBatcher_webhookEnvironmentId_fkey" FOREIGN KEY ("webhookEnvironmentId") REFERENCES "WebhookEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDeliveryBatcher" ADD CONSTRAINT "WebhookDeliveryBatcher_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
