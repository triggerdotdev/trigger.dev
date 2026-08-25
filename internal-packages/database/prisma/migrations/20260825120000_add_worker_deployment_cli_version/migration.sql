-- Stamp the initiating CLI version on deployments at initialization
ALTER TABLE "public"."WorkerDeployment" ADD COLUMN IF NOT EXISTS "cliVersion" TEXT;
