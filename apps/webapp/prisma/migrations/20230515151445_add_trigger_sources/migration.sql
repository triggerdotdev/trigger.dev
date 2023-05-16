/*
  Warnings:

  - You are about to drop the column `active` on the `HttpSource` table. All the data in the column will be lost.
  - You are about to drop the column `connectionId` on the `HttpSource` table. All the data in the column will be lost.
  - You are about to drop the column `endpointId` on the `HttpSource` table. All the data in the column will be lost.
  - You are about to drop the column `environmentId` on the `HttpSource` table. All the data in the column will be lost.
  - You are about to drop the column `key` on the `HttpSource` table. All the data in the column will be lost.
  - You are about to drop the column `organizationId` on the `HttpSource` table. All the data in the column will be lost.
  - You are about to drop the column `projectId` on the `HttpSource` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[triggerSourceId]` on the table `HttpSource` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `triggerSourceId` to the `HttpSource` table without a default value. This is not possible if the table is not empty.
  - Made the column `secret` on table `HttpSource` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "TriggerChannel" AS ENUM ('HTTP', 'SQS', 'SMTP');

-- DropForeignKey
ALTER TABLE "HttpSource" DROP CONSTRAINT "HttpSource_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "HttpSource" DROP CONSTRAINT "HttpSource_endpointId_fkey";

-- DropForeignKey
ALTER TABLE "HttpSource" DROP CONSTRAINT "HttpSource_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "HttpSource" DROP CONSTRAINT "HttpSource_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "HttpSource" DROP CONSTRAINT "HttpSource_projectId_fkey";

-- DropIndex
DROP INDEX "HttpSource_key_endpointId_key";

-- AlterTable
ALTER TABLE "HttpSource" DROP COLUMN "active",
DROP COLUMN "connectionId",
DROP COLUMN "endpointId",
DROP COLUMN "environmentId",
DROP COLUMN "key",
DROP COLUMN "organizationId",
DROP COLUMN "projectId",
ADD COLUMN     "params" JSONB,
ADD COLUMN     "triggerSourceId" TEXT NOT NULL,
ALTER COLUMN "secret" SET NOT NULL;

-- CreateTable
CREATE TABLE "TriggerSource" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "channel" "TriggerChannel" NOT NULL DEFAULT 'HTTP',
    "organizationId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "apiClientId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "interactive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriggerSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriggerSourceEvent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "registered" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TriggerSourceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TriggerSource_key_endpointId_key" ON "TriggerSource"("key", "endpointId");

-- CreateIndex
CREATE UNIQUE INDEX "TriggerSourceEvent_name_sourceId_key" ON "TriggerSourceEvent"("name", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "HttpSource_triggerSourceId_key" ON "HttpSource"("triggerSourceId");

-- AddForeignKey
ALTER TABLE "TriggerSource" ADD CONSTRAINT "TriggerSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerSource" ADD CONSTRAINT "TriggerSource_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerSource" ADD CONSTRAINT "TriggerSource_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerSource" ADD CONSTRAINT "TriggerSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerSource" ADD CONSTRAINT "TriggerSource_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiConnectionClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerSourceEvent" ADD CONSTRAINT "TriggerSourceEvent_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TriggerSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HttpSource" ADD CONSTRAINT "HttpSource_triggerSourceId_fkey" FOREIGN KEY ("triggerSourceId") REFERENCES "TriggerSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
