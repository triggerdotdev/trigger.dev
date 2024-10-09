/*
  Warnings:

  - You are about to drop the column `lastIndexedAt` on the `Endpoint` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "EndpointIndexSource" AS ENUM ('MANUAL', 'ENDPOINT_INITIATED', 'HOOK');

-- AlterTable
ALTER TABLE "Endpoint" DROP COLUMN "lastIndexedAt";

-- CreateTable
CREATE TABLE "EndpointIndex" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "source" "EndpointIndexSource" NOT NULL DEFAULT 'MANUAL',
    "reason" TEXT,
    "data" JSONB NOT NULL,
    "stats" JSONB NOT NULL,

    CONSTRAINT "EndpointIndex_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "EndpointIndex" ADD CONSTRAINT "EndpointIndex_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
