-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "allowedMasterQueues" TEXT[] DEFAULT ARRAY[]::TEXT[];