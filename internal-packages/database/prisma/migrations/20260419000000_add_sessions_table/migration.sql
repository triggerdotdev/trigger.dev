-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "externalId" TEXT,
    "type" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "environmentType" "RuntimeEnvironmentType" NOT NULL,
    "organizationId" TEXT NOT NULL,
    "taskIdentifier" TEXT,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_friendlyId_key"
    ON "Session"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_runtimeEnvironmentId_externalId_key"
    ON "Session"("runtimeEnvironmentId", "externalId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx"
    ON "Session"("expiresAt");
