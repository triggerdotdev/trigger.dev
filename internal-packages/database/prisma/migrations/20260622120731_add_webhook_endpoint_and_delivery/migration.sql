-- CreateEnum
CREATE TYPE "public"."WebhookEndpointStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DELETING');

-- CreateEnum
CREATE TYPE "public"."WebhookDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');

-- NOTE (Q5): ALTER TYPE "TaskTriggerSource" ADD VALUE 'WEBHOOK' lives in the earlier
-- 20260622120730_add_webhook_trigger_source migration, not here.

-- CreateTable
CREATE TABLE "public"."WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "opaqueId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "environmentType" "public"."RuntimeEnvironmentType" NOT NULL,
    "endpointTenantId" TEXT NOT NULL DEFAULT '',
    "endpointExternalRef" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL,
    "handlerWebhookId" TEXT NOT NULL,
    "routingTarget" JSONB NOT NULL,
    "verifierArtifact" JSONB NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "signingSecretKey" TEXT,
    "status" "public"."WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable (HAND-EDITED: PARTITION BY RANGE clause; clone of TaskEventPartitioned migration.sql:54)
CREATE TABLE "public"."WebhookDelivery" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "webhookEndpointId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "environmentType" "public"."RuntimeEnvironmentType" NOT NULL,
    "externalDeliveryId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "runId" TEXT,
    "status" "public"."WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "parsedEvent" JSONB,
    "rawBodyHash" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id","createdAt")
) PARTITION BY RANGE ("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEndpoint_friendlyId_key" ON "public"."WebhookEndpoint"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEndpoint_opaqueId_key" ON "public"."WebhookEndpoint"("opaqueId");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_runtimeEnvironmentId_source_idx" ON "public"."WebhookEndpoint"("runtimeEnvironmentId", "source");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_projectId_createdAt_idx" ON "public"."WebhookEndpoint"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEndpoint_runtimeEnvironmentId_handlerWebhookId_endpo_key" ON "public"."WebhookEndpoint"("runtimeEnvironmentId", "handlerWebhookId", "endpointTenantId", "endpointExternalRef");

-- CreateIndex (on the PARENT; auto-propagates to every child at PARTITION OF time)
CREATE INDEX "WebhookDelivery_webhookEndpointId_createdAt_idx" ON "public"."WebhookDelivery"("webhookEndpointId", "createdAt" DESC);

-- No DEFAULT partition on purpose: retention drops use DETACH ... CONCURRENTLY, which a default forbids.
