-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "organizationTemplateId" TEXT;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_organizationTemplateId_fkey" FOREIGN KEY ("organizationTemplateId") REFERENCES "OrganizationTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
