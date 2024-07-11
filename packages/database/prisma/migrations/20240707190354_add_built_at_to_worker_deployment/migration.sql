-- AlterTable
ALTER TABLE "WorkerDeployment" ADD COLUMN     "builtAt" TIMESTAMP(3);

-- Set "builtAt" to "deployedAt" for all existing WorkerDeployments
UPDATE "WorkerDeployment" SET "builtAt" = "deployedAt";

-- Set "builtAt" to "failedAt" for all failed deployments where "imageReference" is not null
UPDATE "WorkerDeployment" SET "builtAt" = "failedAt" WHERE "failedAt" IS NOT NULL AND "imageReference" IS NOT NULL;