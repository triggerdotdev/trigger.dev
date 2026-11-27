-- AlterTable
ALTER TABLE "public"."SessionRun" ADD COLUMN IF NOT EXISTS "handover" JSONB;
