/*
  Warnings:

  - You are about to drop the column `durationInMs` on the `TaskEvent` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "TaskEvent" DROP COLUMN "durationInMs",
ADD COLUMN     "duration" BIGINT NOT NULL DEFAULT 0;
