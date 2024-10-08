/*
  Warnings:

  - You are about to drop the column `buildLogLatestLog` on the `ProjectDeployment` table. All the data in the column will be lost.
  - You are about to drop the column `machineLogLatestLog` on the `ProjectDeployment` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ProjectDeployment" DROP COLUMN "buildLogLatestLog",
DROP COLUMN "machineLogLatestLog";

-- CreateTable
CREATE TABLE "DeploymentLogPoll" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "logType" "DeploymentLogType" NOT NULL DEFAULT 'BUILD',
    "from" TIMESTAMP(3) NOT NULL,
    "to" TIMESTAMP(3) NOT NULL,
    "totalLogsCount" INTEGER NOT NULL,
    "filteredLogsCount" INTEGER NOT NULL,

    CONSTRAINT "DeploymentLogPoll_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "DeploymentLogPoll" ADD CONSTRAINT "DeploymentLogPoll_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "ProjectDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
