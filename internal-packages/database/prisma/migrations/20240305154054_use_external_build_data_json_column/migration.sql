/*
  Warnings:

  - You are about to drop the column `buildId` on the `WorkerDeployment` table. All the data in the column will be lost.
  - You are about to drop the column `buildToken` on the `WorkerDeployment` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "WorkerDeploymentStatus" ADD VALUE 'BUILDING';

-- AlterTable
ALTER TABLE "WorkerDeployment" DROP COLUMN "buildId",
DROP COLUMN "buildToken",
ADD COLUMN     "externalBuildData" JSONB;
