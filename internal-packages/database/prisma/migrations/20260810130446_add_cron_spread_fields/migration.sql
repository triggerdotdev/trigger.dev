-- AlterTable
ALTER TABLE "public"."TaskSchedule"
  ADD COLUMN     "windowDurationSeconds" INTEGER,
  ADD COLUMN     "windowPercentage" INTEGER;

-- AlterTable
ALTER TABLE "public"."TaskScheduleInstance"
  ADD COLUMN     "schedulePhase" INTEGER;
