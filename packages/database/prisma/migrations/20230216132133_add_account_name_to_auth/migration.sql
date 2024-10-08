/*
  Warnings:

  - Added the required column `accountName` to the `GitHubAppAuthorization` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "GitHubAppAuthorization" ADD COLUMN     "accountName" TEXT NOT NULL;
