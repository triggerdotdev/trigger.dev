/*
  Warnings:

  - Added the required column `environmentId` to the `WebhookRequestDelivery` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "WebhookRequestDelivery" ADD COLUMN     "environmentId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "WebhookRequestDelivery" ADD CONSTRAINT "WebhookRequestDelivery_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
