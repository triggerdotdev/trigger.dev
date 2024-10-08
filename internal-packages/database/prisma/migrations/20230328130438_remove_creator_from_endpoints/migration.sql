/*
  Warnings:

  - You are about to drop the column `creatorId` on the `Endpoint` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Endpoint" DROP CONSTRAINT "Endpoint_creatorId_fkey";

-- AlterTable
ALTER TABLE "Endpoint" DROP COLUMN "creatorId";
