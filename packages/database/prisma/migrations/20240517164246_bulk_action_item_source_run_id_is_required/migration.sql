/*
  Warnings:

  - Made the column `sourceRunId` on table `BulkActionItem` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "BulkActionItem" ALTER COLUMN "sourceRunId" SET NOT NULL;
