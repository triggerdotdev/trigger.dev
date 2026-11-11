-- AlterTable
ALTER TABLE "PersonalAccessToken" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
