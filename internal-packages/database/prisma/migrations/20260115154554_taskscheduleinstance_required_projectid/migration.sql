/*
Warnings:

- Made the column `projectId` on table `TaskScheduleInstance` required. This step will fail if there are existing NULL values in that column.

 */
-- Backfill from TaskSchedule
UPDATE "TaskScheduleInstance" tsi
SET
  "projectId" = ts."projectId"
FROM
  "TaskSchedule" ts
WHERE
  tsi."taskScheduleId" = ts."id"
  AND tsi."projectId" IS NULL;

-- AlterTable
ALTER TABLE "public"."TaskScheduleInstance"
ALTER COLUMN "projectId"
SET
  NOT NULL;