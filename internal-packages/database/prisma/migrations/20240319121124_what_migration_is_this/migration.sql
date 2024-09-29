/*
  Warnings:

  - Made the column `startTime` on table `TaskEvent` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "TaskEvent" ALTER COLUMN "startTime" SET NOT NULL;
