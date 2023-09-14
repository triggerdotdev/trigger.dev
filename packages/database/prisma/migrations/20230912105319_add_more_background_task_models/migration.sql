-- CreateEnum
CREATE TYPE "BackgroundTaskProvider" AS ENUM ('FLY_IO');

-- CreateEnum
CREATE TYPE "BackgroundTaskMachineStatus" AS ENUM ('CREATED', 'STARTING', 'STARTED', 'STOPPING', 'STOPPED', 'DESTROYING', 'DESTROYED', 'REPLACING');

-- CreateEnum
CREATE TYPE "BackgroundTaskOperationStatus" AS ENUM ('PENDING', 'STARTED', 'SUCCESS', 'FAILURE');

-- CreateTable
CREATE TABLE "BackgroundTaskImage" (
    "id" TEXT NOT NULL,
    "provider" "BackgroundTaskProvider" NOT NULL,
    "name" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "backgroundTaskId" TEXT NOT NULL,
    "backgroundTaskArtifactId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundTaskImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundTaskMachine" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "provider" "BackgroundTaskProvider" NOT NULL,
    "data" JSONB NOT NULL,
    "status" "BackgroundTaskMachineStatus" NOT NULL DEFAULT 'CREATED',
    "backgroundTaskId" TEXT NOT NULL,
    "backgroundTaskVersionId" TEXT NOT NULL,
    "backgroundTaskImageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundTaskMachine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundTaskOperation" (
    "id" TEXT NOT NULL,
    "backgroundTaskId" TEXT NOT NULL,
    "backgroundTaskVersionId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "output" JSONB,
    "error" JSONB,
    "status" "BackgroundTaskOperationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "BackgroundTaskOperation_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "BackgroundTaskImage" ADD CONSTRAINT "BackgroundTaskImage_backgroundTaskId_fkey" FOREIGN KEY ("backgroundTaskId") REFERENCES "BackgroundTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskImage" ADD CONSTRAINT "BackgroundTaskImage_backgroundTaskArtifactId_fkey" FOREIGN KEY ("backgroundTaskArtifactId") REFERENCES "BackgroundTaskArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskMachine" ADD CONSTRAINT "BackgroundTaskMachine_backgroundTaskId_fkey" FOREIGN KEY ("backgroundTaskId") REFERENCES "BackgroundTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskMachine" ADD CONSTRAINT "BackgroundTaskMachine_backgroundTaskVersionId_fkey" FOREIGN KEY ("backgroundTaskVersionId") REFERENCES "BackgroundTaskVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskMachine" ADD CONSTRAINT "BackgroundTaskMachine_backgroundTaskImageId_fkey" FOREIGN KEY ("backgroundTaskImageId") REFERENCES "BackgroundTaskImage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskOperation" ADD CONSTRAINT "BackgroundTaskOperation_backgroundTaskId_fkey" FOREIGN KEY ("backgroundTaskId") REFERENCES "BackgroundTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTaskOperation" ADD CONSTRAINT "BackgroundTaskOperation_backgroundTaskVersionId_fkey" FOREIGN KEY ("backgroundTaskVersionId") REFERENCES "BackgroundTaskVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
