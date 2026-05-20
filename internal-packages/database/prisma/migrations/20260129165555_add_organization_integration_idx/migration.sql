-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "OrganizationIntegration_externalOrganizationId_idx" ON "public"."OrganizationIntegration"("externalOrganizationId");

