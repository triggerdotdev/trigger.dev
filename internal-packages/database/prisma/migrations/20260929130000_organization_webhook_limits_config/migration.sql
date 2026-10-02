ALTER TABLE "public"."Organization" ADD COLUMN IF NOT EXISTS "webhookLimitsConfig" JSONB;
