-- CreateTable
CREATE TABLE "public"."OrganizationProjectIntegration" (
    "id" TEXT NOT NULL,
    "organizationIntegrationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "externalEntityId" TEXT NOT NULL,
    "integrationData" JSONB NOT NULL,
    "installedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "OrganizationProjectIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationProjectIntegration_projectId_idx" ON "public"."OrganizationProjectIntegration"("projectId");

-- CreateIndex
CREATE INDEX "OrganizationProjectIntegration_projectId_organizationIntegr_idx" ON "public"."OrganizationProjectIntegration"("projectId", "organizationIntegrationId");

-- CreateIndex
CREATE INDEX "OrganizationProjectIntegration_externalEntityId_idx" ON "public"."OrganizationProjectIntegration"("externalEntityId");

-- AddForeignKey
ALTER TABLE "public"."OrganizationProjectIntegration" ADD CONSTRAINT "OrganizationProjectIntegration_organizationIntegrationId_fkey" FOREIGN KEY ("organizationIntegrationId") REFERENCES "public"."OrganizationIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationProjectIntegration" ADD CONSTRAINT "OrganizationProjectIntegration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
