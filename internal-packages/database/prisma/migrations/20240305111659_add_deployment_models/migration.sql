/*
  Warnings:

  - A unique constraint covering the columns `[backgroundWorkerId]` on the table `ImageDetails` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "WorkerDeploymentStatus" AS ENUM ('PENDING', 'DEPLOYING', 'DEPLOYED', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "WorkerDeployment" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "buildId" TEXT NOT NULL,
    "buildToken" TEXT NOT NULL,
    "status" "WorkerDeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "workerId" TEXT,
    "deployedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerDeploymentPromotion" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,

    CONSTRAINT "WorkerDeploymentPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkerDeployment_friendlyId_key" ON "WorkerDeployment"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerDeployment_workerId_key" ON "WorkerDeployment"("workerId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerDeployment_projectId_shortCode_key" ON "WorkerDeployment"("projectId", "shortCode");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerDeployment_environmentId_version_key" ON "WorkerDeployment"("environmentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerDeploymentPromotion_environmentId_label_key" ON "WorkerDeploymentPromotion"("environmentId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "ImageDetails_backgroundWorkerId_key" ON "ImageDetails"("backgroundWorkerId");

-- AddForeignKey
ALTER TABLE "WorkerDeployment" ADD CONSTRAINT "WorkerDeployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerDeployment" ADD CONSTRAINT "WorkerDeployment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerDeployment" ADD CONSTRAINT "WorkerDeployment_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerDeploymentPromotion" ADD CONSTRAINT "WorkerDeploymentPromotion_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "WorkerDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerDeploymentPromotion" ADD CONSTRAINT "WorkerDeploymentPromotion_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
