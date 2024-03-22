/*
 Warnings:
 
 - Changed the type of `startTime` on the `TaskEvent` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
 
 */
-- AlterTable
BEGIN;

-- Step 1: Add a new column
ALTER TABLE
  "TaskEvent"
ADD
  COLUMN "temporary_startTime" BIGINT;

-- Step 2: Convert the data in the current "startTime" column to nanoseconds
UPDATE
  "TaskEvent"
SET
  "temporary_startTime" = EXTRACT(
    EPOCH
    FROM
      "startTime"
  ) * 1000000000;

-- Step 3: Drop the original column
ALTER TABLE
  "TaskEvent" DROP COLUMN "startTime";

-- Step 4: Rename the new column
ALTER TABLE
  "TaskEvent" RENAME COLUMN "temporary_startTime" TO "startTime";

COMMIT;