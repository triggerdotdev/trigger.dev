/*
  Warnings:

  - You are about to drop the `_TaskRunToTaskRunTag` table. If the table is not empty, all the data it contains will be lost.

*/

-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

-- DropTable
DROP TABLE IF EXISTS "_TaskRunToTaskRunTag" CASCADE;
