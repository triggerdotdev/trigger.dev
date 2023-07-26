/*
  Warnings:

  - The `event` column on the `EventDispatcher` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "EventDispatcher" DROP COLUMN "event",
ADD COLUMN     "event" TEXT[];
