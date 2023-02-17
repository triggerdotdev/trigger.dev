-- CreateEnum
CREATE TYPE "OrganizationTemplateStatus" AS ENUM ('PENDING', 'CREATED', 'READY_TO_DEPLOY', 'DEPLOYED', 'READY_TO_TEST', 'READY_TO_RUN');

-- AlterTable
ALTER TABLE "OrganizationTemplate" ADD COLUMN     "status" "OrganizationTemplateStatus" NOT NULL DEFAULT 'PENDING';
