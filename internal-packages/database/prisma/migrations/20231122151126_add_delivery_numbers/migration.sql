/*
  Warnings:

  - Added the required column `number` to the `WebhookRequestDelivery` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "WebhookRequestDelivery" ADD COLUMN     "number" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "WebhookDeliveryCounter" (
    "webhookId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WebhookDeliveryCounter_pkey" PRIMARY KEY ("webhookId")
);
