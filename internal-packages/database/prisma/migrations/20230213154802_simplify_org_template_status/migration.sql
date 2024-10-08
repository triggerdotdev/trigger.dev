/*
  Warnings:

  - The values [READY_TO_TEST,READY_TO_RUN] on the enum `OrganizationTemplateStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "OrganizationTemplateStatus_new" AS ENUM ('PENDING', 'CREATED', 'READY_TO_DEPLOY', 'DEPLOYED');
ALTER TABLE "OrganizationTemplate" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "OrganizationTemplate" ALTER COLUMN "status" TYPE "OrganizationTemplateStatus_new" USING ("status"::text::"OrganizationTemplateStatus_new");
ALTER TYPE "OrganizationTemplateStatus" RENAME TO "OrganizationTemplateStatus_old";
ALTER TYPE "OrganizationTemplateStatus_new" RENAME TO "OrganizationTemplateStatus";
DROP TYPE "OrganizationTemplateStatus_old";
ALTER TABLE "OrganizationTemplate" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;
