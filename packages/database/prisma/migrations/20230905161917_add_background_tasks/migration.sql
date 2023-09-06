-- CreateTable
CREATE TABLE "BackgroundTask" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BackgroundTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundTaskVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "cpu" INTEGER NOT NULL DEFAULT 1,
    "memory" INTEGER NOT NULL DEFAULT 256,
    "concurrency" INTEGER NOT NULL DEFAULT 1,
    "backgroundTaskId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundTaskVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundTaskAlias" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'latest',
    "value" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "backgroundTaskId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,

    CONSTRAINT "BackgroundTaskAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundTaskSecret" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "secretReferenceId" TEXT NOT NULL,
    "backgroundTaskVersionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundTaskSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundTask_projectId_slug_key" ON "BackgroundTask"("projectId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundTaskVersion_backgroundTaskId_version_environmentI_key" ON "BackgroundTaskVersion"("backgroundTaskId", "version", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundTaskAlias_backgroundTaskId_environmentId_name_key" ON "BackgroundTaskAlias"("backgroundTaskId", "environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundTaskSecret_backgroundTaskVersionId_key_key" ON "BackgroundTaskSecret"("backgroundTaskVersionId", "key");

-- AddForeignKey
ALTER TABLE "BackgroundTask" ADD CONSTRAINT "BackgroundTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTask" ADD CONSTRAINT "BackgroundTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskVersion" ADD CONSTRAINT "BackgroundTaskVersion_backgroundTaskId_fkey" FOREIGN KEY ("backgroundTaskId") REFERENCES "BackgroundTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskVersion" ADD CONSTRAINT "BackgroundTaskVersion_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskVersion" ADD CONSTRAINT "BackgroundTaskVersion_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskVersion" ADD CONSTRAINT "BackgroundTaskVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskVersion" ADD CONSTRAINT "BackgroundTaskVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskAlias" ADD CONSTRAINT "BackgroundTaskAlias_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "BackgroundTaskVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskAlias" ADD CONSTRAINT "BackgroundTaskAlias_backgroundTaskId_fkey" FOREIGN KEY ("backgroundTaskId") REFERENCES "BackgroundTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskAlias" ADD CONSTRAINT "BackgroundTaskAlias_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskSecret" ADD CONSTRAINT "BackgroundTaskSecret_secretReferenceId_fkey" FOREIGN KEY ("secretReferenceId") REFERENCES "SecretReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskSecret" ADD CONSTRAINT "BackgroundTaskSecret_backgroundTaskVersionId_fkey" FOREIGN KEY ("backgroundTaskVersionId") REFERENCES "BackgroundTaskVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
