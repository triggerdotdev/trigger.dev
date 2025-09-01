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
CREATE TABLE "public"."ConnectedGithubRepository" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "branchTracking" JSONB NOT NULL,
    "previewDeploymentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedGithubRepository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectedGithubRepository_repositoryId_idx" ON "public"."ConnectedGithubRepository"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedGithubRepository_projectId_key" ON "public"."ConnectedGithubRepository"("projectId");

-- CreateIndex
CREATE INDEX "SecretStore_key_idx" ON "public"."SecretStore"("key" text_pattern_ops);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_id_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "id" DESC);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_createdAt_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "public"."ConnectedGithubRepository" ADD CONSTRAINT "ConnectedGithubRepository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConnectedGithubRepository" ADD CONSTRAINT "ConnectedGithubRepository_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "public"."GithubRepository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
