/*
  Warnings:

  - A unique constraint covering the columns `[environmentId,httpEndpointId]` on the table `TriggerHttpEndpointEnvironment` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "TriggerHttpEndpointEnvironment_environmentId_httpEndpointId_key" ON "TriggerHttpEndpointEnvironment"("environmentId", "httpEndpointId");
