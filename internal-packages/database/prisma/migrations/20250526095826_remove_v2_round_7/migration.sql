/*
  Warnings:

  - You are about to drop the `JobVersion` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TriggerHttpEndpoint` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE IF EXISTS "JobVersion" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "TriggerHttpEndpoint" CASCADE;
