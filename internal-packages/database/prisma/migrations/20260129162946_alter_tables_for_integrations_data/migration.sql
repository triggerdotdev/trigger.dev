-- AlterEnum
ALTER TYPE "public"."IntegrationService" ADD VALUE 'VERCEL';

-- AlterTable
ALTER TABLE "public"."OrganizationIntegration" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "externalOrganizationId" TEXT;

-- AlterTable
ALTER TABLE "public"."WorkerDeployment" ADD COLUMN     "commitSHA" TEXT;
