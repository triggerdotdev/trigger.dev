/*
  Warnings:

  - Added the required column `repositoryData` to the `OrganizationTemplate` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "OrganizationTemplate" ADD COLUMN     "repositoryData" JSONB NOT NULL;
