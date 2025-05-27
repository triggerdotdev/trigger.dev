/*
  Warnings:

  - You are about to drop the column `httpEndpointEnvironmentId` on the `EventRecord` table. All the data in the column will be lost.
  - You are about to drop the `TriggerHttpEndpointEnvironment` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "EventRecord" DROP COLUMN IF EXISTS "httpEndpointEnvironmentId" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "TriggerHttpEndpointEnvironment" CASCADE;
