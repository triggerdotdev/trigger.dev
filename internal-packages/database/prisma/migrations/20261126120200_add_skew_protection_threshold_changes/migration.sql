-- CreateTable
CREATE TABLE IF NOT EXISTS "SkewProtectionThresholdChange" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "taskIdentifier" TEXT,
    "kind" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "currentVersion" TEXT,
    "source" TEXT NOT NULL,
    "userId" TEXT,
    "apiKeyName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkewProtectionThresholdChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SkewProtectionThresholdChange_environmentId_createdAt_idx" ON "SkewProtectionThresholdChange"("environmentId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "SkewProtectionThresholdChange" DROP CONSTRAINT IF EXISTS "SkewProtectionThresholdChange_environmentId_fkey", ADD CONSTRAINT "SkewProtectionThresholdChange_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
