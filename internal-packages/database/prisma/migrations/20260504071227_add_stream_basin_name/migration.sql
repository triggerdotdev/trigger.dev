-- AlterTable
ALTER TABLE "public"."Organization" ADD COLUMN IF NOT EXISTS "streamBasinName" TEXT;

-- AlterTable
ALTER TABLE "public"."Session" ADD COLUMN IF NOT EXISTS "streamBasinName" TEXT;

-- AlterTable
ALTER TABLE "public"."TaskRun" ADD COLUMN IF NOT EXISTS "streamBasinName" TEXT;
