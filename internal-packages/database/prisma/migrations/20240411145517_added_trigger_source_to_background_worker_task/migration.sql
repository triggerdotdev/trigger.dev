-- CreateEnum
CREATE TYPE "TaskTriggerSource" AS ENUM ('STANDARD', 'SCHEDULED');

-- AlterTable
ALTER TABLE "BackgroundWorkerTask" ADD COLUMN     "triggerSource" "TaskTriggerSource" NOT NULL DEFAULT 'STANDARD';
