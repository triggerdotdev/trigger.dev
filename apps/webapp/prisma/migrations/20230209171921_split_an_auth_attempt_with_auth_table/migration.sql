/*
  Warnings:

  - You are about to drop the column `status` on the `GitHubAppAuthorization` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "GitHubAppAuthorization" DROP COLUMN "status";

-- DropEnum
DROP TYPE "GitHubAppAuthorizationStatus";

-- CreateTable
CREATE TABLE "GitHubAppAuthorizationAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "GitHubAppAuthorizationAttempt_pkey" PRIMARY KEY ("id")
);
