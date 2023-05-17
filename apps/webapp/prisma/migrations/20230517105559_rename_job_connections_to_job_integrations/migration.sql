/*
  Warnings:

  - You are about to drop the `JobConnection` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "JobConnection" DROP CONSTRAINT "JobConnection_apiConnectionClientId_fkey";

-- DropForeignKey
ALTER TABLE "JobConnection" DROP CONSTRAINT "JobConnection_jobId_fkey";

-- DropForeignKey
ALTER TABLE "JobConnection" DROP CONSTRAINT "JobConnection_versionId_fkey";

-- DropTable
DROP TABLE "JobConnection";

-- CreateTable
CREATE TABLE "JobIntegration" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "connectionMetadata" JSONB NOT NULL,
    "apiConnectionClientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobIntegration_versionId_key_key" ON "JobIntegration"("versionId", "key");

-- AddForeignKey
ALTER TABLE "JobIntegration" ADD CONSTRAINT "JobIntegration_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "JobVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobIntegration" ADD CONSTRAINT "JobIntegration_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobIntegration" ADD CONSTRAINT "JobIntegration_apiConnectionClientId_fkey" FOREIGN KEY ("apiConnectionClientId") REFERENCES "ApiConnectionClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
