/*
  Warnings:

  - A unique constraint covering the columns `[organizationId,key]` on the table `ExternalSource` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ExternalSource_organizationId_key_key" ON "ExternalSource"("organizationId", "key");
