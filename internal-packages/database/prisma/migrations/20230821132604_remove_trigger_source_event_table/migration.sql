/*
  Warnings:

  - You are about to drop the `TriggerSourceEvent` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "TriggerSourceEvent" DROP CONSTRAINT "TriggerSourceEvent_sourceId_fkey";

-- DropTable
DROP TABLE "TriggerSourceEvent";
