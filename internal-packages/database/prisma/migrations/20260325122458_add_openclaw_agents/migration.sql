-- CreateTable "AgentConfig"
CREATE TABLE "AgentConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "messagingPlatform" TEXT NOT NULL,
    "tools" TEXT,
    "containerName" TEXT,
    "containerPort" INTEGER,
    "slackWorkspaceId" TEXT,
    "slackWebhookToken" TEXT,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable "AgentExecution"
CREATE TABLE "AgentExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "executionTimeMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentExecution_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable "AgentHealthCheck"
CREATE TABLE "AgentHealthCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "isHealthy" BOOLEAN NOT NULL,
    "responseTimeMs" INTEGER,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentHealthCheck_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AgentConfig_userId_idx" ON "AgentConfig"("userId");

-- CreateIndex
CREATE INDEX "AgentConfig_slackWorkspaceId_idx" ON "AgentConfig"("slackWorkspaceId");

-- CreateIndex
CREATE INDEX "AgentConfig_status_idx" ON "AgentConfig"("status");

-- CreateIndex
CREATE INDEX "AgentExecution_agentId_idx" ON "AgentExecution"("agentId");

-- CreateIndex
CREATE INDEX "AgentExecution_createdAt_idx" ON "AgentExecution"("createdAt");

-- CreateIndex
CREATE INDEX "AgentHealthCheck_agentId_idx" ON "AgentHealthCheck"("agentId");

-- CreateIndex
CREATE INDEX "AgentHealthCheck_createdAt_idx" ON "AgentHealthCheck"("createdAt");
