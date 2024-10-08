-- CreateEnum
CREATE TYPE "ProjectDeploymentStatus" AS ENUM ('PENDING', 'DEPLOYING', 'DEPLOYED', 'ERROR');

-- CreateTable
CREATE TABLE "ProjectDeployment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "status" "ProjectDeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "imageIdentifier" TEXT,
    "branch" TEXT NOT NULL,
    "commitHash" TEXT NOT NULL,
    "commitMessage" TEXT NOT NULL,
    "committer" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectDeployment_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ProjectDeployment" ADD CONSTRAINT "ProjectDeployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "RepositoryProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDeployment" ADD CONSTRAINT "ProjectDeployment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
