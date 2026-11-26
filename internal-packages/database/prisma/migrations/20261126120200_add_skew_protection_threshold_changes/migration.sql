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

-- A history row for each threshold copied from the staff-set floor, so the Deployments history starts
-- with where the threshold came from. Skipped for environments that already have one, so a re-run is a no-op.
INSERT INTO "SkewProtectionThresholdChange" ("id", "environmentId", "kind", "version", "source", "createdAt")
SELECT
  'sptc_' || md5(e."id" || ':migrated'),
  e."id",
  'set',
  e."skewProtectionThresholds" -> 'environment' ->> 'version',
  'migrated',
  coalesce((e."skewProtectionThresholds" -> 'environment' ->> 'setAt')::timestamp, now())
FROM "RuntimeEnvironment" AS e
WHERE e."skewProtectionThresholds" -> 'environment' -> 'setBy' ->> 'type' = 'migrated'
  AND coalesce(e."skewProtectionThresholds" -> 'environment' ->> 'version', '') <> ''
ON CONFLICT ("id") DO NOTHING;
