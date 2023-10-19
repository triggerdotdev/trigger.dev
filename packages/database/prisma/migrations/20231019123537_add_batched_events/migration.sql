-- AlterTable
ALTER TABLE "EventDispatcher" ADD COLUMN     "batch" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "JobRun" ADD COLUMN     "eventIds" TEXT[],
ADD COLUMN     "payload" JSONB;
