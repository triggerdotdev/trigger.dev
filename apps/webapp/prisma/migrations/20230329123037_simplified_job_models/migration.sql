/*
  Warnings:

  - You are about to drop the column `versionId` on the `JobInstance` table. All the data in the column will be lost.
  - You are about to drop the `JobAlias` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobVersion` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[jobId,version,endpointId]` on the table `JobInstance` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `environmentId` to the `JobInstance` table without a default value. This is not possible if the table is not empty.
  - Added the required column `organizationId` to the `JobInstance` table without a default value. This is not possible if the table is not empty.
  - Added the required column `trigger` to the `JobInstance` table without a default value. This is not possible if the table is not empty.
  - Added the required column `version` to the `JobInstance` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "JobAlias" DROP CONSTRAINT "JobAlias_jobId_fkey";

-- DropForeignKey
ALTER TABLE "JobAlias" DROP CONSTRAINT "JobAlias_jobVersionId_fkey";

-- DropForeignKey
ALTER TABLE "JobInstance" DROP CONSTRAINT "JobInstance_versionId_fkey";

-- DropForeignKey
ALTER TABLE "JobVersion" DROP CONSTRAINT "JobVersion_jobId_fkey";

-- DropIndex
DROP INDEX "JobInstance_jobId_versionId_endpointId_key";

-- AlterTable
ALTER TABLE "JobInstance" DROP COLUMN "versionId",
ADD COLUMN     "environmentId" TEXT NOT NULL,
ADD COLUMN     "organizationId" TEXT NOT NULL,
ADD COLUMN     "trigger" JSONB NOT NULL,
ADD COLUMN     "version" TEXT NOT NULL;

-- DropTable
DROP TABLE "JobAlias";

-- DropTable
DROP TABLE "JobVersion";

-- CreateIndex
CREATE UNIQUE INDEX "JobInstance_jobId_version_endpointId_key" ON "JobInstance"("jobId", "version", "endpointId");

-- AddForeignKey
ALTER TABLE "JobInstance" ADD CONSTRAINT "JobInstance_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobInstance" ADD CONSTRAINT "JobInstance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
