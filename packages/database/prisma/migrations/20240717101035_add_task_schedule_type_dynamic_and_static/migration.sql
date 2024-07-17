-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('STATIC', 'DYNAMIC');

-- AlterTable
ALTER TABLE "TaskSchedule" ADD COLUMN     "type" "ScheduleType" NOT NULL DEFAULT 'DYNAMIC';
