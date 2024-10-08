/*
  Warnings:

  - You are about to drop the `HttpSource` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `channelData` to the `TriggerSource` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "HttpSource" DROP CONSTRAINT "HttpSource_triggerSourceId_fkey";

-- DropForeignKey
ALTER TABLE "HttpSourceRequestDelivery" DROP CONSTRAINT "HttpSourceRequestDelivery_sourceId_fkey";

-- AlterTable
ALTER TABLE "TriggerSource" ADD COLUMN     "channelData" JSONB NOT NULL;

-- DropTable
DROP TABLE "HttpSource";

-- AddForeignKey
ALTER TABLE "HttpSourceRequestDelivery" ADD CONSTRAINT "HttpSourceRequestDelivery_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TriggerSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
