-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN "sessionDuration" INTEGER NOT NULL DEFAULT 31556952;

-- AlterTable
ALTER TABLE "public"."Organization" ADD COLUMN "maxSessionDuration" INTEGER;
