/*
  Warnings:

  - You are about to drop the `ImageDetails` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "ImageDetails" DROP CONSTRAINT "ImageDetails_backgroundWorkerId_fkey";

-- DropForeignKey
ALTER TABLE "ImageDetails" DROP CONSTRAINT "ImageDetails_projectId_fkey";

-- DropForeignKey
ALTER TABLE "ImageDetails" DROP CONSTRAINT "ImageDetails_runtimeEnvironmentId_fkey";

-- AlterTable
ALTER TABLE "WorkerDeployment" ADD COLUMN     "imageReference" TEXT;

-- DropTable
DROP TABLE "ImageDetails";
