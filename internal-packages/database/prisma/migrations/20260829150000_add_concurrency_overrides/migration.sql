-- AlterTable
ALTER TABLE "TaskQueue" ADD COLUMN "totalConcurrencyLimitOverriddenAt" TIMESTAMP(3);
ALTER TABLE "TaskQueue" ADD COLUMN "totalConcurrencyLimitOverriddenBy" TEXT;
ALTER TABLE "TaskQueue" ADD COLUMN "totalConcurrencyLimitBase" INTEGER;
