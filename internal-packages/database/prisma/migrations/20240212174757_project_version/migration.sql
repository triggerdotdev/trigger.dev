-- CreateEnum
CREATE TYPE "ProjectVersion" AS ENUM ('V2', 'V3');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "version" "ProjectVersion" NOT NULL DEFAULT 'V2';
