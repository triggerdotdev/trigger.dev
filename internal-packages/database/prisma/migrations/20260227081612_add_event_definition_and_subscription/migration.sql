-- AlterTable
ALTER TABLE "public"."BackgroundWorkerTask" ADD COLUMN     "onEventSlug" TEXT;

-- CreateTable
CREATE TABLE "public"."EventDefinition" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "description" TEXT,
    "schema" JSONB,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EventSubscription" (
    "id" TEXT NOT NULL,
    "eventDefinitionId" TEXT NOT NULL,
    "taskSlug" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "filter" JSONB,
    "pattern" TEXT,
    "consumerGroup" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventDefinition_projectId_slug_idx" ON "public"."EventDefinition"("projectId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "EventDefinition_projectId_slug_version_key" ON "public"."EventDefinition"("projectId", "slug", "version");

-- CreateIndex
CREATE INDEX "EventSubscription_eventDefinitionId_environmentId_enabled_idx" ON "public"."EventSubscription"("eventDefinitionId", "environmentId", "enabled");

-- CreateIndex
CREATE INDEX "EventSubscription_projectId_environmentId_idx" ON "public"."EventSubscription"("projectId", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "EventSubscription_eventDefinitionId_taskSlug_environmentId_key" ON "public"."EventSubscription"("eventDefinitionId", "taskSlug", "environmentId");

-- AddForeignKey
ALTER TABLE "public"."EventDefinition" ADD CONSTRAINT "EventDefinition_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventSubscription" ADD CONSTRAINT "EventSubscription_eventDefinitionId_fkey" FOREIGN KEY ("eventDefinitionId") REFERENCES "public"."EventDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventSubscription" ADD CONSTRAINT "EventSubscription_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventSubscription" ADD CONSTRAINT "EventSubscription_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventSubscription" ADD CONSTRAINT "EventSubscription_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "public"."BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
