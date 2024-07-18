-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('DECLARATIVE', 'IMPERATIVE');

-- AlterTable
ALTER TABLE "TaskSchedule"
ADD COLUMN "type" "ScheduleType" NOT NULL DEFAULT 'IMPERATIVE';