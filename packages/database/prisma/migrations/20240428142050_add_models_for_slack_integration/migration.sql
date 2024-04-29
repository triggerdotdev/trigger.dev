-- CreateEnum
CREATE TYPE "IntegrationService" AS ENUM ('SLACK');

-- AlterTable
ALTER TABLE "ProjectAlertChannel" ADD COLUMN     "integrationId" TEXT;

-- CreateTable
CREATE TABLE "OrganizationIntegration" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "service" "IntegrationService" NOT NULL,
    "integrationData" JSONB,
    "tokenReferenceId" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationIntegration_friendlyId_key" ON "OrganizationIntegration"("friendlyId");

-- AddForeignKey
ALTER TABLE "ProjectAlertChannel" ADD CONSTRAINT "ProjectAlertChannel_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "OrganizationIntegration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationIntegration" ADD CONSTRAINT "OrganizationIntegration_tokenReferenceId_fkey" FOREIGN KEY ("tokenReferenceId") REFERENCES "SecretReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationIntegration" ADD CONSTRAINT "OrganizationIntegration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
