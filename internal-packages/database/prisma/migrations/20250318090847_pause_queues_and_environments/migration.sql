-- AlterTable
ALTER TABLE "RuntimeEnvironment"
ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TaskQueue"
ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false;