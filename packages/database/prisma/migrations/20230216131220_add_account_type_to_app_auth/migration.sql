-- CreateEnum
CREATE TYPE "GitHubAccountType" AS ENUM ('USER', 'ORGANIZATION');

-- AlterTable
ALTER TABLE "GitHubAppAuthorization" ADD COLUMN     "accountType" "GitHubAccountType" NOT NULL DEFAULT 'USER';
