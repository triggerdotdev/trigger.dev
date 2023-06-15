/*
  Warnings:

  - You are about to drop the `GitHubRepository` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "RepositoryProjectStatus" AS ENUM ('PENDING', 'DEPLOYING', 'DEPLOYED', 'ERROR', 'DISABLED');

-- DropForeignKey
ALTER TABLE "GitHubRepository" DROP CONSTRAINT "GitHubRepository_authorizationId_fkey";

-- DropForeignKey
ALTER TABLE "GitHubRepository" DROP CONSTRAINT "GitHubRepository_templateId_fkey";

-- DropTable
DROP TABLE "GitHubRepository";

-- CreateTable
CREATE TABLE "RepositoryProject" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "authorizationId" TEXT NOT NULL,
    "buildCommand" TEXT NOT NULL,
    "startCommand" TEXT NOT NULL,
    "autoDeploy" BOOLEAN NOT NULL DEFAULT true,
    "envVars" JSONB NOT NULL,
    "dockerDefinitionUrl" TEXT NOT NULL,
    "status" "RepositoryProjectStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepositoryProject_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "RepositoryProject" ADD CONSTRAINT "RepositoryProject_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "GitHubAppAuthorization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
