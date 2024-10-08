-- CreateEnum
CREATE TYPE "ProjectAlertChannelType" AS ENUM ('EMAIL', 'SLACK', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "ProjectAlertType" AS ENUM ('TASK_RUN_ATTEMPT', 'DEPLOYMENT_FAILURE');

-- CreateEnum
CREATE TYPE "ProjectAlertStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "ProjectAlertChannel" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "type" "ProjectAlertChannelType" NOT NULL,
    "name" TEXT NOT NULL,
    "properties" JSONB NOT NULL,
    "alertTypes" "ProjectAlertType"[],
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAlertChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectAlert" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" "ProjectAlertStatus" NOT NULL DEFAULT 'PENDING',
    "type" "ProjectAlertType" NOT NULL,
    "taskRunAttemptId" TEXT,
    "workerDeploymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAlertChannel_friendlyId_key" ON "ProjectAlertChannel"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAlert_friendlyId_key" ON "ProjectAlert"("friendlyId");

-- AddForeignKey
ALTER TABLE "ProjectAlertChannel" ADD CONSTRAINT "ProjectAlertChannel_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAlert" ADD CONSTRAINT "ProjectAlert_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAlert" ADD CONSTRAINT "ProjectAlert_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAlert" ADD CONSTRAINT "ProjectAlert_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ProjectAlertChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAlert" ADD CONSTRAINT "ProjectAlert_taskRunAttemptId_fkey" FOREIGN KEY ("taskRunAttemptId") REFERENCES "TaskRunAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAlert" ADD CONSTRAINT "ProjectAlert_workerDeploymentId_fkey" FOREIGN KEY ("workerDeploymentId") REFERENCES "WorkerDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
