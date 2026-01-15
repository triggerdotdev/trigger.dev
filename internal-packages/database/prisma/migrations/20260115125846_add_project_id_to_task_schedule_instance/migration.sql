-- AlterTable
ALTER TABLE "public"."TaskScheduleInstance"
ADD COLUMN IF NOT EXISTS "projectId" TEXT;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TaskScheduleInstance_projectId_fkey'
  ) THEN
    ALTER TABLE "public"."TaskScheduleInstance"
    ADD CONSTRAINT "TaskScheduleInstance_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "public"."Project" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;