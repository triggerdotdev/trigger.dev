/*
  Warnings:

  - You are about to drop the column `httpEndpointEnvironmentId` on the `EventRecord` table. All the data in the column will be lost.
  - You are about to drop the `TriggerHttpEndpointEnvironment` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM information_schema.tables 
        WHERE table_name = 'EventRecord'
    ) THEN
        ALTER TABLE "EventRecord" DROP COLUMN IF EXISTS "httpEndpointEnvironmentId" CASCADE;
    END IF;
END $$;


-- DropTable
DROP TABLE IF EXISTS "TriggerHttpEndpointEnvironment" CASCADE;
