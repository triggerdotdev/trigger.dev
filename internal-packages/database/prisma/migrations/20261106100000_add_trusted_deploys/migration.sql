CREATE TABLE IF NOT EXISTS "TrustedDeployRepository" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL DEFAULT 'https://token.actions.githubusercontent.com',
    "repositoryOwner" TEXT NOT NULL,
    "repositoryName" TEXT NOT NULL,
    "repositoryId" TEXT,
    "repositoryOwnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrustedDeployRepository_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TrustedDeployRepository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

DO $$
BEGIN
    CREATE TYPE "TrustedDeployScope" AS ENUM ('ANY', 'BRANCH', 'TAG', 'ENVIRONMENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "TrustedDeployEnvironment" (
    "id" TEXT NOT NULL,
    "trustedDeployRepositoryId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "scope" "TrustedDeployScope" NOT NULL,
    "scopeValue" TEXT,
    "additionalClaims" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrustedDeployEnvironment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TrustedDeployEnvironment_trustedDeployRepositoryId_fkey" FOREIGN KEY ("trustedDeployRepositoryId") REFERENCES "TrustedDeployRepository"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrustedDeployEnvironment_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "TrustedDeployRepository_projectId_key" ON "TrustedDeployRepository"("projectId");
CREATE UNIQUE INDEX IF NOT EXISTS "TrustedDeployEnvironment_runtimeEnvironmentId_key" ON "TrustedDeployEnvironment"("runtimeEnvironmentId");
CREATE INDEX IF NOT EXISTS "TrustedDeployEnvironment_trustedDeployRepositoryId_idx" ON "TrustedDeployEnvironment"("trustedDeployRepositoryId");
