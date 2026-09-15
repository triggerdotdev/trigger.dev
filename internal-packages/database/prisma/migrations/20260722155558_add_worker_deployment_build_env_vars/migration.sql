-- AlterTable
ALTER TABLE "public"."WorkerDeployment" ADD COLUMN IF NOT EXISTS "buildEnvVars" JSONB;
