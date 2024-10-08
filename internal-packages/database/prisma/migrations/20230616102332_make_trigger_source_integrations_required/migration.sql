/*
  Warnings:

  - Made the column `integrationId` on table `TriggerSource` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "TriggerSource" ALTER COLUMN "integrationId" SET NOT NULL;
