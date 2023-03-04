-- AlterEnum
ALTER TYPE "ExternalSourceType" ADD VALUE 'INTEGRATION_WEBHOOK';

-- AlterTable
ALTER TABLE "TriggerEvent" ADD COLUMN     "displayProperties" JSONB;
