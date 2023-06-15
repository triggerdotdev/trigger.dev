-- AlterTable
ALTER TABLE "ProjectDeployment" ADD COLUMN     "vmIdentifier" TEXT;

-- AlterTable
ALTER TABLE "RepositoryProject" ADD COLUMN     "currentVMIdentifier" TEXT;
