-- CreateEnum
CREATE TYPE "JobTriggerStartPosition" AS ENUM ('INITIAL', 'LATEST');

-- AlterTable
ALTER TABLE "JobTrigger" ADD COLUMN     "startPosition" "JobTriggerStartPosition" NOT NULL DEFAULT 'INITIAL';
