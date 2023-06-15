/*
  Warnings:

  - You are about to drop the column `refreshToken` on the `GitHubAppAuthorization` table. All the data in the column will be lost.
  - You are about to drop the column `refreshTokenExpiresAt` on the `GitHubAppAuthorization` table. All the data in the column will be lost.
  - You are about to drop the column `token` on the `GitHubAppAuthorization` table. All the data in the column will be lost.
  - You are about to drop the column `tokenExpiresAt` on the `GitHubAppAuthorization` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "GitHubAppAuthorization" DROP COLUMN "refreshToken",
DROP COLUMN "refreshTokenExpiresAt",
DROP COLUMN "token",
DROP COLUMN "tokenExpiresAt";
