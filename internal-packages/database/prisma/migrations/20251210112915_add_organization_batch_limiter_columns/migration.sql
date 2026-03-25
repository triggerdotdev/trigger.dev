-- AlterTable
ALTER TABLE "public"."Organization" ADD COLUMN     "batchQueueConcurrencyConfig" JSONB,
ADD COLUMN     "batchRateLimitConfig" JSONB;