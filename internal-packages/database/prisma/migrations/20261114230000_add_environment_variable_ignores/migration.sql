DO $$
BEGIN
    CREATE TYPE "EnvironmentVariableIgnoreReason" AS ENUM ('EMPTY', 'MISSING', 'OIDC');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "EnvironmentVariableIgnore" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "variableId" TEXT NOT NULL,
    "reason" "EnvironmentVariableIgnoreReason" NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnvironmentVariableIgnore_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EnvironmentVariableIgnore_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EnvironmentVariableIgnore_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EnvironmentVariableIgnore_variableId_fkey" FOREIGN KEY ("variableId") REFERENCES "EnvironmentVariable"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EnvironmentVariableIgnore_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "EnvironmentVariableIgnore_environmentId_variableId_reason_key" ON "EnvironmentVariableIgnore"("environmentId", "variableId", "reason");
CREATE INDEX IF NOT EXISTS "EnvironmentVariableIgnore_variableId_idx" ON "EnvironmentVariableIgnore"("variableId");
CREATE INDEX IF NOT EXISTS "EnvironmentVariableIgnore_projectId_idx" ON "EnvironmentVariableIgnore"("projectId");
