/*
  Warnings:

  - You are about to drop the column `organizationId` on the `GitHubAppAuthorization` table. All the data in the column will be lost.
  - You are about to drop the column `organizationId` on the `GitHubAppAuthorizationAttempt` table. All the data in the column will be lost.
  - You are about to drop the column `templateId` on the `GitHubAppAuthorizationAttempt` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "GitHubAppAuthorization" DROP CONSTRAINT "GitHubAppAuthorization_organizationId_fkey";

-- AlterTable
ALTER TABLE "GitHubAppAuthorization" DROP COLUMN "organizationId";

-- AlterTable
ALTER TABLE "GitHubAppAuthorizationAttempt" DROP COLUMN "organizationId",
DROP COLUMN "templateId";

-- CreateTable
CREATE TABLE "GitHubRepository" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "templateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubRepository_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "GitHubRepository" ADD CONSTRAINT "GitHubRepository_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "GitHubAppAuthorization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubRepository" ADD CONSTRAINT "GitHubRepository_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;
