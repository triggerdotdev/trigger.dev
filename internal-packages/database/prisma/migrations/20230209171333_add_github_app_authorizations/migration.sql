-- CreateTable
CREATE TABLE "GitHubAppAuthorization" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "refreshTokenExpiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubAppAuthorization_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "GitHubAppAuthorization" ADD CONSTRAINT "GitHubAppAuthorization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubAppAuthorization" ADD CONSTRAINT "GitHubAppAuthorization_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
