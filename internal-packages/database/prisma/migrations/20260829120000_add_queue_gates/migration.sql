-- AlterTable
ALTER TABLE "BackgroundWorkerTask" ADD COLUMN "gates" JSONB;

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN "gates" JSONB;
