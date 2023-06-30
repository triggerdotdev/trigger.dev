-- CreateEnum
CREATE TYPE "IntegrationSetupStatus" AS ENUM ('MISSING_FIELDS', 'COMPLETE');

-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "setupStatus" "IntegrationSetupStatus" NOT NULL DEFAULT 'COMPLETE';
