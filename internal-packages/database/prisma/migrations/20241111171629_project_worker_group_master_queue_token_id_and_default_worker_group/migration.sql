/*
  Warnings:

  - You are about to drop the `Worker` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[defaultWorkerGroupId]` on the table `Project` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[masterQueue]` on the table `WorkerGroup` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tokenId]` on the table `WorkerGroup` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `name` to the `WorkerGroup` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tokenId` to the `WorkerGroup` table without a default value. This is not possible if the table is not empty.
  - Added the required column `type` to the `WorkerGroup` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `WorkerGroup` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "WorkerInstanceGroupType" AS ENUM ('SHARED', 'UNMANAGED');

-- AlterTable
ALTER TABLE "BackgroundWorker" ADD COLUMN     "workerGroupId" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "defaultWorkerGroupId" TEXT;

-- AlterTable
ALTER TABLE "TaskRunExecutionSnapshot" ADD COLUMN     "lastHeartbeatAt" TIMESTAMP(3),
ADD COLUMN     "workerId" TEXT;

-- AlterTable
ALTER TABLE "WorkerGroup" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "hidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "tokenId" TEXT NOT NULL,
ADD COLUMN     "type" "WorkerInstanceGroupType" NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- DropTable
DROP TABLE "Worker";

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerInstance" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workerGroupId" TEXT NOT NULL,
    "organizationId" TEXT,
    "projectId" TEXT,
    "environmentId" TEXT,
    "deploymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastDequeueAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),

    CONSTRAINT "WorkerInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerGroupToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerGroupToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "FeatureFlag"("key");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerInstance_workerGroupId_name_key" ON "WorkerInstance"("workerGroupId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerGroupToken_tokenHash_key" ON "WorkerGroupToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Project_defaultWorkerGroupId_key" ON "Project"("defaultWorkerGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerGroup_masterQueue_key" ON "WorkerGroup"("masterQueue");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerGroup_tokenId_key" ON "WorkerGroup"("tokenId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_defaultWorkerGroupId_fkey" FOREIGN KEY ("defaultWorkerGroupId") REFERENCES "WorkerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundWorker" ADD CONSTRAINT "BackgroundWorker_workerGroupId_fkey" FOREIGN KEY ("workerGroupId") REFERENCES "WorkerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "WorkerInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerInstance" ADD CONSTRAINT "WorkerInstance_workerGroupId_fkey" FOREIGN KEY ("workerGroupId") REFERENCES "WorkerGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerInstance" ADD CONSTRAINT "WorkerInstance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerInstance" ADD CONSTRAINT "WorkerInstance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerInstance" ADD CONSTRAINT "WorkerInstance_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerInstance" ADD CONSTRAINT "WorkerInstance_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "WorkerDeployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerGroup" ADD CONSTRAINT "WorkerGroup_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "WorkerGroupToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerGroup" ADD CONSTRAINT "WorkerGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerGroup" ADD CONSTRAINT "WorkerGroup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
