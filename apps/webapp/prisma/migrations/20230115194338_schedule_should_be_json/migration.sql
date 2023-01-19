/*
  Warnings:

  - Changed the type of `schedule` on the `SchedulerSource` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "SchedulerSource" DROP COLUMN "schedule",
ADD COLUMN     "schedule" JSONB NOT NULL;
