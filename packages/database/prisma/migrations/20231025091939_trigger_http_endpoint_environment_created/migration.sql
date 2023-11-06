/*
  Warnings:

  - You are about to drop the column `active` on the `TriggerHttpEndpoint` table. All the data in the column will be lost.
  - You are about to drop the column `immediateResponseFilter` on the `TriggerHttpEndpoint` table. All the data in the column will be lost.
  - Made the column `shortcode` on table `RuntimeEnvironment` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "RuntimeEnvironment" ALTER COLUMN "shortcode" SET NOT NULL;

-- AlterTable
ALTER TABLE "TriggerHttpEndpoint" DROP COLUMN "active",
DROP COLUMN "immediateResponseFilter";

-- CreateTable
CREATE TABLE "TriggerHttpEndpointEnvironment" (
    "id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "immediateResponseFilter" JSONB,
    "environmentId" TEXT NOT NULL,
    "httpEndpointId" TEXT NOT NULL,

    CONSTRAINT "TriggerHttpEndpointEnvironment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TriggerHttpEndpointEnvironment_environmentId_httpEndpointId_key" ON "TriggerHttpEndpointEnvironment"("environmentId", "httpEndpointId");

-- AddForeignKey
ALTER TABLE "TriggerHttpEndpointEnvironment" ADD CONSTRAINT "TriggerHttpEndpointEnvironment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerHttpEndpointEnvironment" ADD CONSTRAINT "TriggerHttpEndpointEnvironment_httpEndpointId_fkey" FOREIGN KEY ("httpEndpointId") REFERENCES "TriggerHttpEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
