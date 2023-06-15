-- AlterEnum
ALTER TYPE "ProjectDeploymentStatus" ADD VALUE 'STOPPED';

-- AlterTable
ALTER TABLE "ProjectDeployment" ADD COLUMN     "stoppedAt" TIMESTAMP(3);
