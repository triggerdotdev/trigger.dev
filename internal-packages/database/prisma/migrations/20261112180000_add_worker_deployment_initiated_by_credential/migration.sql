-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "public"."DeploymentInitiatedByCredential" AS ENUM ('ROOT_API_KEY', 'SCOPED_API_KEY', 'PERSONAL_ACCESS_TOKEN', 'ORGANIZATION_ACCESS_TOKEN', 'TRUSTED_PUBLISHING');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "public"."WorkerDeployment" ADD COLUMN IF NOT EXISTS "initiatedByCredential" "public"."DeploymentInitiatedByCredential";
