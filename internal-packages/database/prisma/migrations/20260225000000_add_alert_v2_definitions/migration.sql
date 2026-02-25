-- CreateEnum
CREATE TYPE "public"."AlertV2State" AS ENUM ('OK', 'FIRING');

-- AlterEnum
ALTER TYPE "public"."ProjectAlertType" ADD VALUE 'ALERT_V2_FIRING';
ALTER TYPE "public"."ProjectAlertType" ADD VALUE 'ALERT_V2_RESOLVED';

-- AlterTable
ALTER TABLE "public"."ProjectAlert" ADD COLUMN "alertV2DefinitionId" TEXT;

-- CreateTable
CREATE TABLE "public"."AlertV2Definition" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "query" TEXT NOT NULL,
    "scope" "public"."CustomerQueryScope" NOT NULL,
    "queryPeriod" TEXT NOT NULL DEFAULT '1h',
    "conditions" JSONB NOT NULL,
    "evaluationIntervalSeconds" INTEGER NOT NULL DEFAULT 300,
    "state" "public"."AlertV2State" NOT NULL DEFAULT 'OK',
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastStateChangedAt" TIMESTAMP(3),
    "alertChannelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "environmentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertV2Definition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AlertV2Definition_friendlyId_key" ON "public"."AlertV2Definition" ("friendlyId");

-- CreateIndex
CREATE INDEX "AlertV2Definition_enabled_lastEvaluatedAt_idx" ON "public"."AlertV2Definition" ("enabled", "lastEvaluatedAt");

-- CreateIndex
CREATE INDEX "AlertV2Definition_organizationId_createdAt_idx" ON "public"."AlertV2Definition" ("organizationId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "public"."ProjectAlert" ADD CONSTRAINT "ProjectAlert_alertV2DefinitionId_fkey" FOREIGN KEY ("alertV2DefinitionId") REFERENCES "public"."AlertV2Definition" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AlertV2Definition" ADD CONSTRAINT "AlertV2Definition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AlertV2Definition" ADD CONSTRAINT "AlertV2Definition_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AlertV2Definition" ADD CONSTRAINT "AlertV2Definition_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AlertV2Definition" ADD CONSTRAINT "AlertV2Definition_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
