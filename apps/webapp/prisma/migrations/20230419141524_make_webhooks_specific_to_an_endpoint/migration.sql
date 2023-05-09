/*
  Warnings:

  - A unique constraint covering the columns `[key,endpointId]` on the table `HttpSource` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "HttpSource_key_organizationId_key";

-- CreateIndex
CREATE UNIQUE INDEX "HttpSource_key_endpointId_key" ON "HttpSource"("key", "endpointId");
