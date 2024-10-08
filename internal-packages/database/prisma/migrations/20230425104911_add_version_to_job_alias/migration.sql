/*
  Warnings:

  - Added the required column `version` to the `JobAlias` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "JobAlias" ADD COLUMN     "version" TEXT NOT NULL;
