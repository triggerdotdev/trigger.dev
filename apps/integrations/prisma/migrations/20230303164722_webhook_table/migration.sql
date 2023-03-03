-- CreateEnum
CREATE TYPE "WebhookType" AS ENUM ('SERVICE', 'GENERIC');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('CREATED', 'READY', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WebhookSubscriptionType" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "type" "WebhookType" NOT NULL,
    "status" "WebhookStatus" NOT NULL,
    "consumerId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "secret" TEXT,
    "subscriptionType" "WebhookSubscriptionType" NOT NULL,
    "externalData" JSONB,
    "service" TEXT,
    "webhookName" TEXT,
    "authenticationData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_consumerId_key_key" ON "Webhook"("consumerId", "key");
