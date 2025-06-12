/*
  Warnings:

  - You are about to drop the `RunConnection` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TriggerSource` table. If the table is not empty, all the data it contains will be lost.

*/

-- DropTable
DROP TABLE IF EXISTS "RunConnection" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "TriggerSource" CASCADE;
