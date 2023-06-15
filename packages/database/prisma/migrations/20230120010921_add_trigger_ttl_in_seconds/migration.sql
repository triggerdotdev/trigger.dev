-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "triggerTtlInSeconds" INTEGER NOT NULL DEFAULT 3600;
