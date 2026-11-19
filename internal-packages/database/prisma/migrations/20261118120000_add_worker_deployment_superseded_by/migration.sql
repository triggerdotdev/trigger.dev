-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

ALTER TABLE "public"."WorkerDeployment" ADD COLUMN IF NOT EXISTS "supersededById" TEXT;

ALTER TABLE "public"."ConnectedGithubRepository" ADD COLUMN IF NOT EXISTS "supersedeProductionBuilds" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "public"."ConnectedGithubRepository" ADD COLUMN IF NOT EXISTS "supersedeStagingBuilds" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "public"."ConnectedGithubRepository" ADD COLUMN IF NOT EXISTS "supersedePreviewBuilds" BOOLEAN NOT NULL DEFAULT true;

