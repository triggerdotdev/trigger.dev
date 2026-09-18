-- AlterTable
ALTER TABLE "TaskQueue" ADD COLUMN IF NOT EXISTS "totalConcurrencyLimitOverriddenAt" TIMESTAMP(3);
ALTER TABLE "TaskQueue" ADD COLUMN IF NOT EXISTS "totalConcurrencyLimitOverriddenBy" TEXT;
ALTER TABLE "TaskQueue" ADD COLUMN IF NOT EXISTS "totalConcurrencyLimitBase" INTEGER;
