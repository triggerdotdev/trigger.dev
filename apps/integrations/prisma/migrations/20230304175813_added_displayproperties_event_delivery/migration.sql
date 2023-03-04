/*
  Warnings:

  - Added the required column `displayProperties` to the `WebhookEventDelivery` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "WebhookEventDelivery" ADD COLUMN     "displayProperties" JSONB NOT NULL;
