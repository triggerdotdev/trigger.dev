-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN IF NOT EXISTS "idempotencyKeyOptions" JSONB;
