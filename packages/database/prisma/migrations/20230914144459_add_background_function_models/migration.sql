-- CreateEnum
CREATE TYPE "BackgroundFunctionTaskStatus" AS ENUM ('PENDING', 'STARTED', 'SUCCESS', 'FAILURE');

-- CreateTable
CREATE TABLE "BackgroundFunction" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BackgroundFunction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundFunctionVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "backgroundFunctionId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundFunctionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundFunctionAlias" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'latest',
    "value" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "backgroundFunctionId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,

    CONSTRAINT "BackgroundFunctionAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundFunctionArtifact" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "bundle" TEXT NOT NULL,
    "sourcemap" JSONB NOT NULL,
    "nodeVersion" TEXT NOT NULL,
    "dependencies" JSONB NOT NULL,
    "backgroundFunctionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundFunctionArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundFunctionImage" (
    "id" TEXT NOT NULL,
    "registry" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "backgroundFunctionId" TEXT NOT NULL,
    "backgroundFunctionArtifactId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundFunctionImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundFunctionTask" (
    "id" TEXT NOT NULL,
    "backgroundFunctionId" TEXT NOT NULL,
    "backgroundFunctionVersionId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "output" JSONB,
    "error" JSONB,
    "status" "BackgroundFunctionTaskStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "BackgroundFunctionTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundFunction_projectId_slug_key" ON "BackgroundFunction"("projectId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundFunctionVersion_backgroundFunctionId_version_envi_key" ON "BackgroundFunctionVersion"("backgroundFunctionId", "version", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundFunctionAlias_backgroundFunctionId_environmentId__key" ON "BackgroundFunctionAlias"("backgroundFunctionId", "environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundFunctionArtifact_backgroundFunctionId_version_has_key" ON "BackgroundFunctionArtifact"("backgroundFunctionId", "version", "hash");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundFunctionImage_backgroundFunctionArtifactId_digest_key" ON "BackgroundFunctionImage"("backgroundFunctionArtifactId", "digest");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundFunctionTask_taskId_key" ON "BackgroundFunctionTask"("taskId");

-- AddForeignKey
ALTER TABLE "BackgroundFunction" ADD CONSTRAINT "BackgroundFunction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunction" ADD CONSTRAINT "BackgroundFunction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionVersion" ADD CONSTRAINT "BackgroundFunctionVersion_backgroundFunctionId_fkey" FOREIGN KEY ("backgroundFunctionId") REFERENCES "BackgroundFunction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionVersion" ADD CONSTRAINT "BackgroundFunctionVersion_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionVersion" ADD CONSTRAINT "BackgroundFunctionVersion_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionVersion" ADD CONSTRAINT "BackgroundFunctionVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionVersion" ADD CONSTRAINT "BackgroundFunctionVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionAlias" ADD CONSTRAINT "BackgroundFunctionAlias_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "BackgroundFunctionVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionAlias" ADD CONSTRAINT "BackgroundFunctionAlias_backgroundFunctionId_fkey" FOREIGN KEY ("backgroundFunctionId") REFERENCES "BackgroundFunction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionAlias" ADD CONSTRAINT "BackgroundFunctionAlias_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionArtifact" ADD CONSTRAINT "BackgroundFunctionArtifact_backgroundFunctionId_fkey" FOREIGN KEY ("backgroundFunctionId") REFERENCES "BackgroundFunction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionImage" ADD CONSTRAINT "BackgroundFunctionImage_backgroundFunctionId_fkey" FOREIGN KEY ("backgroundFunctionId") REFERENCES "BackgroundFunction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionImage" ADD CONSTRAINT "BackgroundFunctionImage_backgroundFunctionArtifactId_fkey" FOREIGN KEY ("backgroundFunctionArtifactId") REFERENCES "BackgroundFunctionArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionTask" ADD CONSTRAINT "BackgroundFunctionTask_backgroundFunctionId_fkey" FOREIGN KEY ("backgroundFunctionId") REFERENCES "BackgroundFunction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionTask" ADD CONSTRAINT "BackgroundFunctionTask_backgroundFunctionVersionId_fkey" FOREIGN KEY ("backgroundFunctionVersionId") REFERENCES "BackgroundFunctionVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundFunctionTask" ADD CONSTRAINT "BackgroundFunctionTask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
