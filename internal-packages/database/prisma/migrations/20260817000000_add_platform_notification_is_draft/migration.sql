-- AlterTable
ALTER TABLE "PlatformNotification" ADD COLUMN IF NOT EXISTS "isDraft" BOOLEAN NOT NULL DEFAULT false;
