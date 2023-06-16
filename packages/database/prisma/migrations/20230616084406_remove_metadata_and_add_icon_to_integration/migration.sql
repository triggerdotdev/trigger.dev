/*
  Warnings:

  - You are about to drop the column `metadata` on the `Integration` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Integration" DROP COLUMN "metadata",
ADD COLUMN     "icon" TEXT;
