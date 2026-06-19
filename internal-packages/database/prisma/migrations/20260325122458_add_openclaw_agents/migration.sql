-- DropIndex
DROP INDEX "public"."SecretStore_key_idx";

-- DropIndex
DROP INDEX "public"."TaskRun_runtimeEnvironmentId_createdAt_idx";

-- DropIndex
DROP INDEX "public"."TaskRun_runtimeEnvironmentId_id_idx";

-- AlterTable
ALTER TABLE "public"."FeatureFlag" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "public"."IntegrationDeployment" ALTER COLUMN "updatedAt" DROP DEFAULT;

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
CREATE TABLE "public"."AgentConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "messagingPlatform" TEXT NOT NULL,
    "tools" JSONB NOT NULL,
    "containerName" TEXT,
    "containerPort" INTEGER,
    "slackWorkspaceId" TEXT,
    "slackWebhookToken" TEXT,
    "apiKeys" JSONB,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AgentExecution" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "toolsUsed" JSONB,
    "executionTimeMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AgentHealthCheck" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "responseTimeMs" INTEGER,
    "isHealthy" BOOLEAN NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentConfig_userId_createdAt_idx" ON "public"."AgentConfig"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AgentConfig_slackWorkspaceId_idx" ON "public"."AgentConfig"("slackWorkspaceId");

-- CreateIndex
CREATE INDEX "AgentExecution_agentId_createdAt_idx" ON "public"."AgentExecution"("agentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AgentHealthCheck_agentId_createdAt_idx" ON "public"."AgentHealthCheck"("agentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SecretStore_key_idx" ON "public"."SecretStore"("key" text_pattern_ops);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_id_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "id" DESC);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_createdAt_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "public"."AgentConfig" ADD CONSTRAINT "AgentConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentExecution" ADD CONSTRAINT "AgentExecution_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."AgentConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentHealthCheck" ADD CONSTRAINT "AgentHealthCheck_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."AgentConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
