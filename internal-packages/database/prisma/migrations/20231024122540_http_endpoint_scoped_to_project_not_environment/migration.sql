/*
  Warnings:

  - You are about to drop the column `environmentId` on the `TriggerHttpEndpoint` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[key,projectId]` on the table `TriggerHttpEndpoint` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "TriggerHttpEndpoint" DROP CONSTRAINT "TriggerHttpEndpoint_environmentId_fkey";

-- DropIndex
DROP INDEX "TriggerHttpEndpoint_key_environmentId_key";

-- AlterTable
ALTER TABLE "TriggerHttpEndpoint" DROP COLUMN "environmentId",
ALTER COLUMN "active" SET DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "TriggerHttpEndpoint_key_projectId_key" ON "TriggerHttpEndpoint"("key", "projectId");
