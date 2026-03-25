-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN "onboardingData" JSONB;

-- AlterTable
ALTER TABLE "public"."Project" ADD COLUMN "onboardingData" JSONB;
