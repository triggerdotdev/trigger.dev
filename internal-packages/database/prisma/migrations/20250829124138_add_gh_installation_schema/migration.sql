-- CreateEnum
CREATE TYPE "public"."GithubRepositorySelection" AS ENUM ('ALL', 'SELECTED');

-- DropIndex
DROP INDEX "public"."SecretStore_key_idx";

-- DropIndex
DROP INDEX "public"."TaskRun_runtimeEnvironmentId_createdAt_idx";

-- DropIndex
DROP INDEX "public"."TaskRun_runtimeEnvironmentId_id_idx";

-- AlterTable
ALTER TABLE "public"."_BackgroundWorkerToBackgroundWorkerFile" ADD CONSTRAINT "_BackgroundWorkerToBackgroundWorkerFile_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_BackgroundWorkerToBackgroundWorkerFile_AB_unique";

-- AlterTable
ALTER TABLE "public"."_BackgroundWorkerToTaskQueue" ADD CONSTRAINT "_BackgroundWorkerToTaskQueue_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_BackgroundWorkerToTaskQueue_AB_unique";

-- AlterTable
ALTER TABLE "public"."_TaskRunToTaskRunTag" ADD CONSTRAINT "_TaskRunToTaskRunTag_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_TaskRunToTaskRunTag_AB_unique";

-- AlterTable
ALTER TABLE "public"."_WaitpointRunConnections" ADD CONSTRAINT "_WaitpointRunConnections_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_WaitpointRunConnections_AB_unique";

-- AlterTable
ALTER TABLE "public"."_completedWaitpoints" ADD CONSTRAINT "_completedWaitpoints_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_completedWaitpoints_AB_unique";

-- CreateTable
CREATE TABLE "public"."GithubAppInstallation" (
    "id" TEXT NOT NULL,
    "appInstallationId" INTEGER NOT NULL,
    "targetId" INTEGER NOT NULL,
    "targetType" TEXT NOT NULL,
    "permissions" JSONB,
    "repositorySelection" "public"."GithubRepositorySelection" NOT NULL,
    "installedBy" TEXT,
    "organizationId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubAppInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GithubRepository" (
    "id" TEXT NOT NULL,
    "githubId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL,
    "removedAt" TIMESTAMP(3),
    "installationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubRepository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GithubAppInstallation_appInstallationId_key" ON "public"."GithubAppInstallation"("appInstallationId");

-- CreateIndex
CREATE INDEX "GithubAppInstallation_organizationId_idx" ON "public"."GithubAppInstallation"("organizationId");

-- CreateIndex
CREATE INDEX "GithubRepository_installationId_idx" ON "public"."GithubRepository"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "GithubRepository_installationId_githubId_key" ON "public"."GithubRepository"("installationId", "githubId");

-- CreateIndex
CREATE INDEX "SecretStore_key_idx" ON "public"."SecretStore"("key" text_pattern_ops);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_id_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "id" DESC);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_createdAt_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "public"."GithubAppInstallation" ADD CONSTRAINT "GithubAppInstallation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GithubRepository" ADD CONSTRAINT "GithubRepository_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "public"."GithubAppInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
