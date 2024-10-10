/*
  Warnings:

  - A unique constraint covering the columns `[repositoryId]` on the table `OrganizationTemplate` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `repositoryId` to the `OrganizationTemplate` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "OrganizationTemplate" ADD COLUMN     "repositoryId" INTEGER NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationTemplate_repositoryId_key" ON "OrganizationTemplate"("repositoryId");
