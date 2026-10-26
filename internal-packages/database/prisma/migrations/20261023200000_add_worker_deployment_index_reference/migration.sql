ALTER TABLE "public"."WorkerDeployment" ADD COLUMN IF NOT EXISTS "indexObjectKey" TEXT;
ALTER TABLE "public"."WorkerDeployment" ADD COLUMN IF NOT EXISTS "indexSha256" TEXT;
ALTER TABLE "public"."WorkerDeployment" ADD COLUMN IF NOT EXISTS "indexFormatVersion" INTEGER;
