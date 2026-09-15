ALTER TABLE "public"."TaskSchedule"
  ADD COLUMN "defaultWindowDurationSeconds" INTEGER,
  ADD COLUMN "minimumWindowDurationSeconds" INTEGER;
