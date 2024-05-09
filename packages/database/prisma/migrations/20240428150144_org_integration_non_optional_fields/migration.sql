/*
  Warnings:

  - Made the column `integrationData` on table `OrganizationIntegration` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tokenReferenceId` on table `OrganizationIntegration` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "OrganizationIntegration" DROP CONSTRAINT "OrganizationIntegration_tokenReferenceId_fkey";

-- AlterTable
ALTER TABLE "OrganizationIntegration" ALTER COLUMN "integrationData" SET NOT NULL,
ALTER COLUMN "tokenReferenceId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "OrganizationIntegration" ADD CONSTRAINT "OrganizationIntegration_tokenReferenceId_fkey" FOREIGN KEY ("tokenReferenceId") REFERENCES "SecretReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;
