DO $$
BEGIN
    CREATE TYPE "public"."OAuthClientKind" AS ENUM ('PREREGISTERED', 'CIMD', 'DCR');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "public"."OAuthClient" (
    "id" TEXT NOT NULL,
    "kind" "public"."OAuthClientKind" NOT NULL,
    "clientId" TEXT NOT NULL,
    "metadataUrl" TEXT,
    "displayName" TEXT,
    "selfReportedName" TEXT,
    "redirectUris" TEXT[],
    "dedupeKey" TEXT,
    "metadataExpiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OAuthClient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."OAuthRefreshToken" (
    "id" TEXT NOT NULL,
    "hashedToken" TEXT NOT NULL,
    "personalAccessTokenId" TEXT NOT NULL,
    "oauthClientId" TEXT NOT NULL,
    "scope" TEXT[],
    "resource" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthRefreshToken_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OAuthRefreshToken_personalAccessTokenId_fkey" FOREIGN KEY ("personalAccessTokenId") REFERENCES "public"."PersonalAccessToken"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OAuthRefreshToken_oauthClientId_fkey" FOREIGN KEY ("oauthClientId") REFERENCES "public"."OAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "OAuthClient_clientId_key" ON "public"."OAuthClient"("clientId");
CREATE UNIQUE INDEX IF NOT EXISTS "OAuthClient_dedupeKey_key" ON "public"."OAuthClient"("dedupeKey");
CREATE UNIQUE INDEX IF NOT EXISTS "OAuthRefreshToken_hashedToken_key" ON "public"."OAuthRefreshToken"("hashedToken");
CREATE INDEX IF NOT EXISTS "OAuthRefreshToken_personalAccessTokenId_idx" ON "public"."OAuthRefreshToken"("personalAccessTokenId");
CREATE INDEX IF NOT EXISTS "OAuthRefreshToken_oauthClientId_idx" ON "public"."OAuthRefreshToken"("oauthClientId");
CREATE INDEX IF NOT EXISTS "OAuthRefreshToken_idleExpiresAt_idx" ON "public"."OAuthRefreshToken"("idleExpiresAt");
CREATE INDEX IF NOT EXISTS "OAuthClient_kind_lastUsedAt_idx" ON "public"."OAuthClient"("kind", "lastUsedAt");

-- AlterTable
ALTER TABLE "public"."AuthorizationCode" ADD COLUMN IF NOT EXISTS "oauthClientId" TEXT,
ADD COLUMN IF NOT EXISTS "redirectUri" TEXT,
ADD COLUMN IF NOT EXISTS "scope" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "resource" TEXT,
ADD COLUMN IF NOT EXISTS "approvedByUserId" TEXT;

-- AlterTable
ALTER TABLE "public"."PersonalAccessToken" ADD COLUMN IF NOT EXISTS "oauthClientId" TEXT;

DO $$
BEGIN
    ALTER TABLE "public"."AuthorizationCode" ADD CONSTRAINT "AuthorizationCode_oauthClientId_fkey" FOREIGN KEY ("oauthClientId") REFERENCES "public"."OAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "public"."PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_oauthClientId_fkey" FOREIGN KEY ("oauthClientId") REFERENCES "public"."OAuthClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
