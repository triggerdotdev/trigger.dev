BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
    CREATE TYPE "EnvironmentKeyWrappingProvider" AS ENUM ('PLATFORM_KEYRING', 'AWS_KMS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "EnvironmentEncryptionKey" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "wrappedKey" JSONB NOT NULL,
    "wrappingProvider" "EnvironmentKeyWrappingProvider" NOT NULL,
    "wrappingKeyReference" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnvironmentEncryptionKey_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EnvironmentEncryptionKey_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "EnvironmentEncryptionKey_id_environmentId_key" ON "EnvironmentEncryptionKey"("id", "environmentId");
CREATE INDEX IF NOT EXISTS "EnvironmentEncryptionKey_environmentId_idx" ON "EnvironmentEncryptionKey"("environmentId");

CREATE TABLE IF NOT EXISTS "EnvironmentEncryptionPolicy" (
    "environmentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "wrappingProvider" "EnvironmentKeyWrappingProvider",
    "wrappingKeyReference" TEXT,
    "activeKeyId" TEXT,
    CONSTRAINT "EnvironmentEncryptionPolicy_pkey" PRIMARY KEY ("environmentId"),
    CONSTRAINT "EnvironmentEncryptionPolicy_wrapping_configuration_check" CHECK (
        ("activeKeyId" IS NULL AND "wrappingProvider" IS NULL AND "wrappingKeyReference" IS NULL)
        OR ("activeKeyId" IS NOT NULL AND "wrappingProvider" IS NOT NULL AND "wrappingKeyReference" IS NOT NULL)
    ),
    CONSTRAINT "EnvironmentEncryptionPolicy_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EnvironmentEncryptionPolicy_activeKeyId_environmentId_fkey" FOREIGN KEY ("activeKeyId", "environmentId") REFERENCES "EnvironmentEncryptionKey"("id", "environmentId") ON DELETE NO ACTION ON UPDATE NO ACTION
);

COMMIT;
