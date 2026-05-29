-- AlterEnum
ALTER TYPE "public"."TaskTriggerSource" ADD VALUE 'AGENT';

-- AlterTable
ALTER TABLE "public"."BackgroundWorkerTask" ADD COLUMN "config" JSONB;
