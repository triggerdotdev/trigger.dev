/*
  Warnings:

  - You are about to drop the `JobRunExecution` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ScheduleSource` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WebhookEnvironment` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE IF EXISTS "JobRunExecution" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "ScheduleSource" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "WebhookEnvironment" CASCADE;
