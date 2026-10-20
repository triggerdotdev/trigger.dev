-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "OidcSigningKeyPurpose" AS ENUM ('EXTERNAL_OIDC', 'INTERNAL_RUN');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable: existing keys are external OIDC keys
ALTER TABLE "OidcSigningKey" ADD COLUMN IF NOT EXISTS "purpose" "OidcSigningKeyPurpose" NOT NULL DEFAULT 'EXTERNAL_OIDC';
