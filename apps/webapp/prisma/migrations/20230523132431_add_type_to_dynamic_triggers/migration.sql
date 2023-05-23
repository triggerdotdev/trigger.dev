/*
  Warnings:

  - A unique constraint covering the columns `[endpointId,slug,type]` on the table `DynamicTrigger` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "DynamicTriggerType" AS ENUM ('EVENT', 'SCHEDULE');

-- DropIndex
DROP INDEX "DynamicTrigger_endpointId_slug_key";

-- AlterTable
ALTER TABLE "DynamicTrigger" ADD COLUMN     "type" "DynamicTriggerType" NOT NULL DEFAULT 'EVENT';

-- CreateIndex
CREATE UNIQUE INDEX "DynamicTrigger_endpointId_slug_type_key" ON "DynamicTrigger"("endpointId", "slug", "type");
