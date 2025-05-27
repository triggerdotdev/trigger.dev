/*
  Warnings:

  - You are about to drop the `ConcurrencyLimitGroup` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Endpoint` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Job` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobQueue` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE IF EXISTS "ConcurrencyLimitGroup" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "Endpoint" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "Job" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "JobQueue" CASCADE;
