-- AlterTable
ALTER TABLE "ProjectDeployment" ADD COLUMN     "buildLogLatestLog" TIMESTAMP(3),
ADD COLUMN     "machineLogLatestLog" TIMESTAMP(3);
