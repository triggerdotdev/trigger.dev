-- AlterTable
ALTER TABLE "GitHubAppAuthorization" ADD COLUMN     "installationAccessToken" TEXT,
ADD COLUMN     "installationAccessTokenExpiresAt" TIMESTAMP(3);
