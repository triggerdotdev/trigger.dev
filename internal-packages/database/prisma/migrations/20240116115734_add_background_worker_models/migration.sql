-- CreateTable
CREATE TABLE "BackgroundWorker" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundWorker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundWorkerTask" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "exportName" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundWorkerTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundWorker_projectId_runtimeEnvironmentId_version_key" ON "BackgroundWorker"("projectId", "runtimeEnvironmentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundWorkerTask_workerId_slug_key" ON "BackgroundWorkerTask"("workerId", "slug");

-- AddForeignKey
ALTER TABLE "BackgroundWorker" ADD CONSTRAINT "BackgroundWorker_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundWorker" ADD CONSTRAINT "BackgroundWorker_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundWorkerTask" ADD CONSTRAINT "BackgroundWorkerTask_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundWorkerTask" ADD CONSTRAINT "BackgroundWorkerTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundWorkerTask" ADD CONSTRAINT "BackgroundWorkerTask_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
