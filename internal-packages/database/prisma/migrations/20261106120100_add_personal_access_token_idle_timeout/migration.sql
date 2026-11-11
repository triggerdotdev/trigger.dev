-- AlterTable
ALTER TABLE "PersonalAccessToken" ADD COLUMN IF NOT EXISTS "idleTimeoutSeconds" INTEGER;
