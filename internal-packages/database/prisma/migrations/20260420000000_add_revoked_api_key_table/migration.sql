-- CreateTable
CREATE TABLE "RevokedApiKey" (
    "id" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevokedApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RevokedApiKey_apiKey_idx"
    ON "RevokedApiKey"("apiKey");

-- CreateIndex
CREATE INDEX "RevokedApiKey_runtimeEnvironmentId_idx"
    ON "RevokedApiKey"("runtimeEnvironmentId");

-- AddForeignKey
ALTER TABLE "RevokedApiKey"
    ADD CONSTRAINT "RevokedApiKey_runtimeEnvironmentId_fkey"
    FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "RuntimeEnvironment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
