-- CreateTable
CREATE TABLE "ImageDetails" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "backgroundWorkerId" TEXT,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageDetails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImageDetails_friendlyId_key" ON "ImageDetails"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageDetails_projectId_runtimeEnvironmentId_tag_key" ON "ImageDetails"("projectId", "runtimeEnvironmentId", "tag");

-- AddForeignKey
ALTER TABLE "ImageDetails" ADD CONSTRAINT "ImageDetails_backgroundWorkerId_fkey" FOREIGN KEY ("backgroundWorkerId") REFERENCES "BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageDetails" ADD CONSTRAINT "ImageDetails_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageDetails" ADD CONSTRAINT "ImageDetails_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
