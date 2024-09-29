/*
  Warnings:

  - You are about to drop the column `deletedAt` on the `Endpoint` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Endpoint" DROP COLUMN "deletedAt",
ALTER COLUMN "url" DROP NOT NULL;
