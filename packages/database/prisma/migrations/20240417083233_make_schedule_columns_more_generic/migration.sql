-- CreateEnum
CREATE TYPE "ScheduleGeneratorType" AS ENUM ('CRON');

-- AlterTable
ALTER TABLE
  "TaskSchedule" RENAME COLUMN "cron" TO "generatorExpression";

ALTER TABLE
  "TaskSchedule" RENAME COLUMN "cronDescription" TO "generatorDescription";

ALTER TABLE
  "TaskSchedule"
ADD
  COLUMN "generatorType" "ScheduleGeneratorType" NOT NULL DEFAULT 'CRON';