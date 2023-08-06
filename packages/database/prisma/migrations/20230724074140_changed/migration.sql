/*
  Warnings:

  - The `event` column on the `EventDispatcher` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
-- Step 1: Create temporary column
ALTER TABLE "EventDispatcher"
ADD COLUMN temp_event TEXT[];

-- Step 2: Update temporary column
UPDATE "EventDispatcher"
SET temp_event = ARRAY[event];

-- Step 3: Drop original column
ALTER TABLE "EventDispatcher"
DROP COLUMN "event";

-- Step 4: Rename temporary column
ALTER TABLE "EventDispatcher"
RENAME COLUMN temp_event TO "event";

