-- AlterTable
ALTER TABLE "BackgroundWorkerTask" ADD COLUMN IF NOT EXISTS "gates" JSONB;

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN IF NOT EXISTS "gates" JSONB;
