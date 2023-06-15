-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobInstance" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAlias" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "jobVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "alias" TEXT,

    CONSTRAINT "JobVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Job_organizationId_slug_key" ON "Job"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "JobInstance_jobId_versionId_endpointId_key" ON "JobInstance"("jobId", "versionId", "endpointId");

-- CreateIndex
CREATE UNIQUE INDEX "JobAlias_jobId_alias_key" ON "JobAlias"("jobId", "alias");

-- CreateIndex
CREATE UNIQUE INDEX "JobVersion_jobId_version_key" ON "JobVersion"("jobId", "version");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobInstance" ADD CONSTRAINT "JobInstance_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobInstance" ADD CONSTRAINT "JobInstance_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "JobVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobInstance" ADD CONSTRAINT "JobInstance_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAlias" ADD CONSTRAINT "JobAlias_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAlias" ADD CONSTRAINT "JobAlias_jobVersionId_fkey" FOREIGN KEY ("jobVersionId") REFERENCES "JobVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobVersion" ADD CONSTRAINT "JobVersion_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
