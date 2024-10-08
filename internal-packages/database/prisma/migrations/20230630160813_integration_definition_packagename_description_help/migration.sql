-- AlterTable
ALTER TABLE "IntegrationAuthMethod" ADD COLUMN     "help" JSONB;

-- AlterTable
ALTER TABLE "IntegrationDefinition" ADD COLUMN     "description" TEXT,
ADD COLUMN     "packageName" TEXT NOT NULL DEFAULT '';
