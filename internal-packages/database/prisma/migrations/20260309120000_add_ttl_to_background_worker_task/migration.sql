-- AlterTable
ALTER TABLE "public"."BackgroundWorkerTask" ADD COLUMN IF NOT EXISTS "ttl" TEXT;
