/*
  Warnings:

  - You are about to drop the column `deployHookIdentifier` on the `Endpoint` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Endpoint" DROP COLUMN "deployHookIdentifier",
ADD COLUMN     "indexingHookIdentifier" TEXT,
ADD COLUMN     "lastIndexedAt" TIMESTAMP(3);
