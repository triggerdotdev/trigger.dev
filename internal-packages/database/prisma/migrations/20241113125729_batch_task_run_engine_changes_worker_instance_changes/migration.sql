/*
  Warnings:

  - You are about to drop the `WorkerGroup` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[runtimeEnvironmentId,idempotencyKey]` on the table `BatchTaskRun` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[workerGroupId,resourceIdentifier]` on the table `WorkerInstance` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `resourceIdentifier` to the `WorkerInstance` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "BackgroundWorker" DROP CONSTRAINT "BackgroundWorker_workerGroupId_fkey";

-- DropForeignKey
ALTER TABLE "Project" DROP CONSTRAINT "Project_defaultWorkerGroupId_fkey";

-- DropForeignKey
ALTER TABLE "WorkerGroup" DROP CONSTRAINT "WorkerGroup_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "WorkerGroup" DROP CONSTRAINT "WorkerGroup_projectId_fkey";

-- DropForeignKey
ALTER TABLE "WorkerGroup" DROP CONSTRAINT "WorkerGroup_tokenId_fkey";

-- DropForeignKey
ALTER TABLE "WorkerInstance" DROP CONSTRAINT "WorkerInstance_workerGroupId_fkey";

-- DropIndex
DROP INDEX "BatchTaskRun_runtimeEnvironmentId_taskIdentifier_idempotenc_key";

-- DropIndex
DROP INDEX "WorkerInstance_workerGroupId_name_key";

-- AlterTable
ALTER TABLE "BatchTaskRun" ALTER COLUMN "taskIdentifier" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "engine" "RunEngineVersion" NOT NULL DEFAULT 'V1';

-- AlterTable
ALTER TABLE "WorkerDeployment" ADD COLUMN     "type" "WorkerInstanceGroupType" NOT NULL DEFAULT 'SHARED';

-- AlterTable
ALTER TABLE "WorkerInstance" ADD COLUMN     "resourceIdentifier" TEXT NOT NULL;

-- DropTable
DROP TABLE "WorkerGroup";

-- CreateTable
CREATE TABLE "WorkerInstanceGroup" (
    "id" TEXT NOT NULL,
    "type" "WorkerInstanceGroupType" NOT NULL,
    "name" TEXT NOT NULL,
    "masterQueue" TEXT NOT NULL,
    "description" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "tokenId" TEXT NOT NULL,
    "organizationId" TEXT,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerInstanceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkerInstanceGroup_masterQueue_key" ON "WorkerInstanceGroup"("masterQueue");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerInstanceGroup_tokenId_key" ON "WorkerInstanceGroup"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_runtimeEnvironmentId_idempotencyKey_key" ON "BatchTaskRun"("runtimeEnvironmentId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerInstance_workerGroupId_resourceIdentifier_key" ON "WorkerInstance"("workerGroupId", "resourceIdentifier");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_defaultWorkerGroupId_fkey" FOREIGN KEY ("defaultWorkerGroupId") REFERENCES "WorkerInstanceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundWorker" ADD CONSTRAINT "BackgroundWorker_workerGroupId_fkey" FOREIGN KEY ("workerGroupId") REFERENCES "WorkerInstanceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerInstance" ADD CONSTRAINT "WorkerInstance_workerGroupId_fkey" FOREIGN KEY ("workerGroupId") REFERENCES "WorkerInstanceGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerInstanceGroup" ADD CONSTRAINT "WorkerInstanceGroup_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "WorkerGroupToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerInstanceGroup" ADD CONSTRAINT "WorkerInstanceGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerInstanceGroup" ADD CONSTRAINT "WorkerInstanceGroup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
