/*
  Warnings:

  - You are about to drop the column `releaseConcurrencyOnWaitpoint` on the `TaskQueue` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "TaskQueue" DROP COLUMN "releaseConcurrencyOnWaitpoint";