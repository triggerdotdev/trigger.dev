-- AlterTable
ALTER TABLE "RepositoryProject" ADD COLUMN     "currentDeploymentId" TEXT;

-- AddForeignKey
ALTER TABLE "RepositoryProject" ADD CONSTRAINT "RepositoryProject_currentDeploymentId_fkey" FOREIGN KEY ("currentDeploymentId") REFERENCES "ProjectDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
