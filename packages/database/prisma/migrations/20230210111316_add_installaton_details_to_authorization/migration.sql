/*
  Warnings:

  - A unique constraint covering the columns `[installationId]` on the table `GitHubAppAuthorization` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `accessTokensUrls` to the `GitHubAppAuthorization` table without a default value. This is not possible if the table is not empty.
  - Added the required column `account` to the `GitHubAppAuthorization` table without a default value. This is not possible if the table is not empty.
  - Added the required column `htmlUrl` to the `GitHubAppAuthorization` table without a default value. This is not possible if the table is not empty.
  - Added the required column `installationId` to the `GitHubAppAuthorization` table without a default value. This is not possible if the table is not empty.
  - Added the required column `permissions` to the `GitHubAppAuthorization` table without a default value. This is not possible if the table is not empty.
  - Added the required column `repositoriesUrl` to the `GitHubAppAuthorization` table without a default value. This is not possible if the table is not empty.
  - Added the required column `repositorySelection` to the `GitHubAppAuthorization` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "GitHubAppAuthorization" ADD COLUMN     "accessTokensUrls" TEXT NOT NULL,
ADD COLUMN     "account" JSONB NOT NULL,
ADD COLUMN     "events" TEXT[],
ADD COLUMN     "htmlUrl" TEXT NOT NULL,
ADD COLUMN     "installationId" INTEGER NOT NULL,
ADD COLUMN     "permissions" JSONB NOT NULL,
ADD COLUMN     "repositoriesUrl" TEXT NOT NULL,
ADD COLUMN     "repositorySelection" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "GitHubAppAuthorization_installationId_key" ON "GitHubAppAuthorization"("installationId");
