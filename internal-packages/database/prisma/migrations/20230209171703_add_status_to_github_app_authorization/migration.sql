-- CreateEnum
CREATE TYPE "GitHubAppAuthorizationStatus" AS ENUM ('PENDING', 'AUTHORIZED');

-- AlterTable
ALTER TABLE "GitHubAppAuthorization" ADD COLUMN     "status" "GitHubAppAuthorizationStatus" NOT NULL DEFAULT 'PENDING';
