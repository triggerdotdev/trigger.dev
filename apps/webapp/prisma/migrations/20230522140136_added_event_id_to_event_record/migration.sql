/*
  Warnings:

  - A unique constraint covering the columns `[eventId,environmentId]` on the table `EventRecord` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `eventId` to the `EventRecord` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "EventRecord" ADD COLUMN     "eventId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "EventRecord_eventId_environmentId_key" ON "EventRecord"("eventId", "environmentId");
