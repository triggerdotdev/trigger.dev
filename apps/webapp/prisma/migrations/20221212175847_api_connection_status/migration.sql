/*
  Warnings:

  - You are about to drop the column `externalId` on the `APIConnection` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "APIConnectionStatus" AS ENUM ('CREATED', 'CONNECTED');

-- AlterTable
ALTER TABLE "APIConnection" DROP COLUMN "externalId",
ADD COLUMN     "status" "APIConnectionStatus" NOT NULL DEFAULT 'CREATED';
