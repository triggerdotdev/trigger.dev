-- CreateEnum
CREATE TYPE "DeploymentLogType" AS ENUM ('BUILD', 'MACHINE');

-- CreateTable
CREATE TABLE "DeploymentLog" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "logType" "DeploymentLogType" NOT NULL DEFAULT 'BUILD',
    "log" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentLog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "ProjectDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
