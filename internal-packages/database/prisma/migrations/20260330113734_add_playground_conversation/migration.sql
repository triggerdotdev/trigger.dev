-- CreateTable
CREATE TABLE "public"."PlaygroundConversation" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New conversation',
    "agentSlug" TEXT NOT NULL,
    "runId" TEXT,
    "clientData" JSONB,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaygroundConversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlaygroundConversation_runtimeEnvironmentId_agentSlug_updat_idx" ON "public"."PlaygroundConversation"("runtimeEnvironmentId", "agentSlug", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "PlaygroundConversation_userId_runtimeEnvironmentId_idx" ON "public"."PlaygroundConversation"("userId", "runtimeEnvironmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaygroundConversation_chatId_runtimeEnvironmentId_key" ON "public"."PlaygroundConversation"("chatId", "runtimeEnvironmentId");

-- AddForeignKey
ALTER TABLE "public"."PlaygroundConversation" ADD CONSTRAINT "PlaygroundConversation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."TaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlaygroundConversation" ADD CONSTRAINT "PlaygroundConversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlaygroundConversation" ADD CONSTRAINT "PlaygroundConversation_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
