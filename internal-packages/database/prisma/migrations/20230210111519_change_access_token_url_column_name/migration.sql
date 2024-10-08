/*
  Warnings:

  - You are about to drop the column `accessTokensUrls` on the `GitHubAppAuthorization` table. All the data in the column will be lost.
  - Added the required column `accessTokensUrl` to the `GitHubAppAuthorization` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "GitHubAppAuthorization" DROP COLUMN "accessTokensUrls",
ADD COLUMN     "accessTokensUrl" TEXT NOT NULL;
