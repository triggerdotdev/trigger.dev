-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "repositoryProjectId" TEXT;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_repositoryProjectId_fkey" FOREIGN KEY ("repositoryProjectId") REFERENCES "RepositoryProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
