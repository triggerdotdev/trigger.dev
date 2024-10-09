/*
  Warnings:

  - A unique constraint covering the columns `[endpointId,httpEndpointId]` on the table `TriggerHttpEndpointEnvironment` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `endpointId` to the `TriggerHttpEndpointEnvironment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TriggerHttpEndpointEnvironment" ADD COLUMN     "endpointId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "TriggerHttpEndpointEnvironment_endpointId_httpEndpointId_key" ON "TriggerHttpEndpointEnvironment"("endpointId", "httpEndpointId");

-- AddForeignKey
ALTER TABLE "TriggerHttpEndpointEnvironment" ADD CONSTRAINT "TriggerHttpEndpointEnvironment_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
