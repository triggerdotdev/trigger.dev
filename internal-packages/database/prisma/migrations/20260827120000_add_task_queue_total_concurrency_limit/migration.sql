-- AlterTable
ALTER TABLE "TaskQueue" ADD COLUMN IF NOT EXISTS "totalConcurrencyLimit" INTEGER;
