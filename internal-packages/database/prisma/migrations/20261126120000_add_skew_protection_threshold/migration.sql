-- AlterTable
ALTER TABLE "RuntimeEnvironment" ADD COLUMN IF NOT EXISTS "skewProtectionThresholds" JSONB;
