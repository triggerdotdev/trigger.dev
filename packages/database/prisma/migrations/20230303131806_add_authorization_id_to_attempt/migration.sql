-- AlterTable
ALTER TABLE "GitHubAppAuthorizationAttempt" ADD COLUMN     "authorizationId" TEXT;

-- AddForeignKey
ALTER TABLE "GitHubAppAuthorizationAttempt" ADD CONSTRAINT "GitHubAppAuthorizationAttempt_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "GitHubAppAuthorization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
