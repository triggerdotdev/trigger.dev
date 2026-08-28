-- AlterTable
ALTER TABLE "public"."TaskSchedule"
  ADD COLUMN     "windowDurationSeconds" INTEGER,
  ADD COLUMN     "windowPercentage" INTEGER;

ALTER TABLE "public"."TaskSchedule"
  ADD CONSTRAINT "TaskSchedule_window_exclusive"
  CHECK (
    "windowDurationSeconds" IS NULL
    OR "windowPercentage" IS NULL
  ) NOT VALID;

-- AlterTable
ALTER TABLE "public"."TaskScheduleInstance"
  ADD COLUMN     "schedulePhase" INTEGER;
