/*
Warnings:

- You are about to drop the column `processedCount` on the `BulkActionGroup` table. All the data in the column will be lost.
- You are about to drop the column `reason` on the `BulkActionGroup` table. All the data in the column will be lost.

 */
-- AlterEnum
ALTER TYPE "BulkActionStatus" ADD VALUE 'ABORTED';

-- AlterTable
ALTER TABLE "BulkActionGroup"
DROP COLUMN "processedCount",
DROP COLUMN "reason",
ADD COLUMN "completedAt" TIMESTAMP(3),
ADD COLUMN "failureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "name" TEXT,
ADD COLUMN "successCount" INTEGER NOT NULL DEFAULT 0;