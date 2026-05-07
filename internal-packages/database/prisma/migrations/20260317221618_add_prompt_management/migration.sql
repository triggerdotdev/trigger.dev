-- CreateTable
CREATE TABLE "public"."prompts" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'text',
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "filePath" TEXT,
    "exportName" TEXT,
    "variableSchema" JSONB,
    "defaultModel" TEXT,
    "defaultConfig" JSONB,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."prompt_versions" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "promptId" TEXT NOT NULL,
    "textContent" TEXT,
    "chatContent" JSONB,
    "model" TEXT,
    "config" JSONB,
    "source" TEXT NOT NULL,
    "commitMessage" TEXT,
    "contentHash" TEXT NOT NULL,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workerId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prompts_projectId_idx" ON "public"."prompts"("projectId");

-- CreateIndex
CREATE INDEX "prompts_runtimeEnvironmentId_idx" ON "public"."prompts"("runtimeEnvironmentId");

-- CreateIndex
CREATE UNIQUE INDEX "prompts_projectId_runtimeEnvironmentId_slug_key" ON "public"."prompts"("projectId", "runtimeEnvironmentId", "slug");

-- CreateIndex
CREATE INDEX "prompt_versions_promptId_idx" ON "public"."prompt_versions"("promptId");

-- CreateIndex
CREATE INDEX "prompt_versions_contentHash_idx" ON "public"."prompt_versions"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_promptId_version_key" ON "public"."prompt_versions"("promptId", "version");

-- AddForeignKey
ALTER TABLE "public"."prompts" ADD CONSTRAINT "prompts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."prompts" ADD CONSTRAINT "prompts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."prompts" ADD CONSTRAINT "prompts_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."prompt_versions" ADD CONSTRAINT "prompt_versions_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "public"."prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."prompt_versions" ADD CONSTRAINT "prompt_versions_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "public"."BackgroundWorker"("id") ON DELETE SET NULL ON UPDATE CASCADE;
