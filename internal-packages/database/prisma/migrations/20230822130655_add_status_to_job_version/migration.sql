-- CreateEnum
CREATE TYPE "JobVersionStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- AlterTable
ALTER TABLE "JobVersion" ADD COLUMN     "status" "JobVersionStatus" NOT NULL DEFAULT 'ACTIVE';
