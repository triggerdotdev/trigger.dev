/*
  Warnings:

  - Added the required column `poolId` to the `BackgroundTaskMachine` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "BackgroundTaskOperationStatus" ADD VALUE 'ASSIGNED_TO_POOL';

-- AlterTable
ALTER TABLE "BackgroundTaskMachine" ADD COLUMN     "poolId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "BackgroundTaskOperation" ADD COLUMN     "poolId" TEXT;

-- CreateTable
CREATE TABLE "BackgroundTaskMachinePool" (
    "id" TEXT NOT NULL,
    "provider" "BackgroundTaskProviderStrategy" NOT NULL,
    "imageId" TEXT NOT NULL,
    "backgroundTaskVersionId" TEXT NOT NULL,
    "backgroundTaskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundTaskMachinePool_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundTaskMachinePool_backgroundTaskVersionId_imageId_key" ON "BackgroundTaskMachinePool"("backgroundTaskVersionId", "imageId");

-- AddForeignKey
ALTER TABLE "BackgroundTaskMachine" ADD CONSTRAINT "BackgroundTaskMachine_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "BackgroundTaskMachinePool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskMachinePool" ADD CONSTRAINT "BackgroundTaskMachinePool_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "BackgroundTaskImage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskMachinePool" ADD CONSTRAINT "BackgroundTaskMachinePool_backgroundTaskVersionId_fkey" FOREIGN KEY ("backgroundTaskVersionId") REFERENCES "BackgroundTaskVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskMachinePool" ADD CONSTRAINT "BackgroundTaskMachinePool_backgroundTaskId_fkey" FOREIGN KEY ("backgroundTaskId") REFERENCES "BackgroundTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskOperation" ADD CONSTRAINT "BackgroundTaskOperation_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "BackgroundTaskMachinePool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
