-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "apiRateLimiterConfig" JSONB,
ADD COLUMN     "realtimeRateLimiterConfig" JSONB;
