/*
  Warnings:

  - You are about to drop the `DynamicTrigger` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `EventDispatcher` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `EventRecord` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobRun` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_DynamicTriggerToJob` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE IF EXISTS "DynamicTrigger" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "EventDispatcher" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "EventRecord" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "JobRun" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "_DynamicTriggerToJob" CASCADE;
