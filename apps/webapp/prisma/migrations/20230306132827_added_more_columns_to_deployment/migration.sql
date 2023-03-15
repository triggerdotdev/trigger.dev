/*
  Warnings:

  - You are about to drop the column `buildDuration` on the `ProjectDeployment` table. All the data in the column will be lost.
  - You are about to drop the column `imageIdentifier` on the `ProjectDeployment` table. All the data in the column will be lost.
  - Added the required column `buildId` to the `ProjectDeployment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ProjectDeployment" DROP COLUMN "buildDuration",
DROP COLUMN "imageIdentifier",
ADD COLUMN     "buildFinishedAt" TIMESTAMP(3),
ADD COLUMN     "buildId" TEXT NOT NULL,
ADD COLUMN     "buildStartedAt" TIMESTAMP(3),
ADD COLUMN     "imageId" TEXT;
