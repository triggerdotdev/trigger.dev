-- AlterEnum
ALTER TYPE "ProjectAlertType" ADD VALUE 'TEST';

-- AlterTable
ALTER TABLE "ProjectAlertChannel" ADD COLUMN     "environmentTypes" "RuntimeEnvironmentType"[] DEFAULT ARRAY['STAGING', 'PRODUCTION']::"RuntimeEnvironmentType"[];
