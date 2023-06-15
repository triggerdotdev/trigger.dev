-- AlterTable
ALTER TABLE "JobInstance" ADD COLUMN     "latest" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "JobAlias" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'latest',
    "jobInstanceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,

    CONSTRAINT "JobAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobAlias_jobId_name_key" ON "JobAlias"("jobId", "name");

-- AddForeignKey
ALTER TABLE "JobAlias" ADD CONSTRAINT "JobAlias_jobInstanceId_fkey" FOREIGN KEY ("jobInstanceId") REFERENCES "JobInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAlias" ADD CONSTRAINT "JobAlias_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
