-- CreateTable
CREATE TABLE "BackgroundTaskArtifact" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "bundle" TEXT NOT NULL,
    "sourcemap" JSONB NOT NULL,
    "nodeVersion" TEXT NOT NULL,
    "dependencies" JSONB NOT NULL,
    "backgroundTaskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundTaskArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundTaskArtifact_backgroundTaskId_version_hash_key" ON "BackgroundTaskArtifact"("backgroundTaskId", "version", "hash");

-- AddForeignKey
ALTER TABLE "BackgroundTaskArtifact" ADD CONSTRAINT "BackgroundTaskArtifact_backgroundTaskId_fkey" FOREIGN KEY ("backgroundTaskId") REFERENCES "BackgroundTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
