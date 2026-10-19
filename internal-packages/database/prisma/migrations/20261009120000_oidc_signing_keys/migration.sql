-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "OidcSigningKeyStatus" AS ENUM ('STAGED', 'ACTIVE', 'RETIRED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "OidcSigningKey" (
    "id" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "status" "OidcSigningKeyStatus" NOT NULL,
    "publicJwk" JSONB NOT NULL,
    "readyAt" TIMESTAMP(3) NOT NULL,
    "publicUntil" TIMESTAMP(3),
    "generatedByUserId" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "activatedByUserId" TEXT,
    "retiredAt" TIMESTAMP(3),
    "retiredByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OidcSigningKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OidcSigningKey_kid_key" ON "OidcSigningKey"("kid");

-- CreateIndex (SQL-only: Prisma can't express partial indexes)
CREATE UNIQUE INDEX IF NOT EXISTS "OidcSigningKey_status_live_key" ON "OidcSigningKey"("status") WHERE "status" IN ('STAGED', 'ACTIVE');
