-- AlterTable
ALTER TABLE "public"."api_keys" ADD COLUMN IF NOT EXISTS "allowed_ip_ranges" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "public"."api_keys" ADD COLUMN IF NOT EXISTS "last_used_ip" TEXT;
