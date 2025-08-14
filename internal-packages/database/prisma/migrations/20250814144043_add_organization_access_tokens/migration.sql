CREATE TYPE "OrganizationAccessTokenType" AS ENUM ('USER', 'SYSTEM');

CREATE TABLE "OrganizationAccessToken" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "OrganizationAccessTokenType" NOT NULL DEFAULT 'USER',
    "encryptedToken" JSONB NOT NULL,
    "obfuscatedToken" TEXT NOT NULL,
    "hashedToken" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastAccessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationAccessToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationAccessToken_hashedToken_key" ON "OrganizationAccessToken"("hashedToken");

CREATE INDEX "OrganizationAccessToken_organizationId_createdAt_idx" ON "OrganizationAccessToken"("organizationId", "createdAt" DESC);

ALTER TABLE "OrganizationAccessToken" ADD CONSTRAINT "OrganizationAccessToken_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
