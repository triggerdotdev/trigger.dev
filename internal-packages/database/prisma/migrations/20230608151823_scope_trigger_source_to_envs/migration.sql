/*
  Warnings:

  - A unique constraint covering the columns `[key,environmentId]` on the table `TriggerSource` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "TriggerSource_key_endpointId_key";

-- CreateIndex
CREATE UNIQUE INDEX "TriggerSource_key_environmentId_key" ON "TriggerSource"("key", "environmentId");
