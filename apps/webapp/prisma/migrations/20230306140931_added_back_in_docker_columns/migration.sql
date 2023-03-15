/*
  Warnings:

  - Added the required column `dockerIgnore` to the `ProjectDeployment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `dockerfile` to the `ProjectDeployment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ProjectDeployment" ADD COLUMN     "dockerIgnore" TEXT NOT NULL,
ADD COLUMN     "dockerfile" TEXT NOT NULL;
