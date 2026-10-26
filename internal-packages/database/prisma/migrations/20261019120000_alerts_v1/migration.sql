-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."Alert" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "capabilityKey" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "condition" JSONB NOT NULL,
    "query" TEXT,
    "expiresAt" TIMESTAMPTZ(6),
    "lifecycle" TEXT NOT NULL DEFAULT 'active',
    "attention" TEXT NOT NULL DEFAULT 'clear',
    "observedCondition" TEXT NOT NULL DEFAULT 'unknown',
    "observedConditionChangedAt" TIMESTAMPTZ(6),
    "pendingMetSince" TIMESTAMPTZ(6),
    "evaluatorState" JSONB,
    "evaluationLeaseId" TEXT,
    "evaluationLeaseUntil" TIMESTAMPTZ(6),
    "lastEvaluatedAt" TIMESTAMPTZ(6),
    "nextEvaluationAt" TIMESTAMPTZ(6),
    "notifiers" JSONB NOT NULL DEFAULT '[]',
    "name" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),
    "resolvedBy" TEXT,
    "stoppedAt" TIMESTAMPTZ(6),
    "stoppedBy" TEXT,
    "lastOccurrenceAt" TIMESTAMPTZ(6),
    "occurrencesSinceRaise" INTEGER NOT NULL DEFAULT 0,
    "occurrencesTotal" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."AlertEvent" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "actorId" TEXT,
    "sourceEventId" TEXT,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id","at")
) PARTITION BY RANGE ("at");

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."AlertOccurrenceSeen" (
    "alertId" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "rowTime" TIMESTAMPTZ(6) NOT NULL,
    "seenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AlertOccurrenceSeen_pkey" PRIMARY KEY ("alertId","sourceEventId")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."AlertDelivery" (
    "id" TEXT NOT NULL,
    "alertEventId" TEXT NOT NULL,
    "eventAt" TIMESTAMPTZ(6) NOT NULL,
    "notifierId" TEXT NOT NULL,
    "notifier" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimId" TEXT,
    "claimedAt" TIMESTAMPTZ(6),
    "deliveredAt" TIMESTAMPTZ(6),
    "failureReason" TEXT,
    "providerMetadata" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "firstAttemptAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertDelivery_pkey" PRIMARY KEY ("id","eventAt")
) PARTITION BY RANGE ("eventAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Alert_environmentId_lifecycle_idx" ON "public"."Alert"("environmentId", "lifecycle");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Alert_lifecycle_evaluationLeaseUntil_idx" ON "public"."Alert"("lifecycle", "evaluationLeaseUntil");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Alert_lifecycle_nextEvaluationAt_idx" ON "public"."Alert"("lifecycle", "nextEvaluationAt" NULLS FIRST);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Alert_projectId_idx" ON "public"."Alert"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Alert_organizationId_idx" ON "public"."Alert"("organizationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Alert_active_expiresAt_idx" ON "public"."Alert"("expiresAt") WHERE "lifecycle" = 'active' AND "expiresAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AlertEvent_alertId_at_idx" ON "public"."AlertEvent"("alertId", "at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AlertOccurrenceSeen_expiresAt_idx" ON "public"."AlertOccurrenceSeen"("expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AlertDelivery_status_createdAt_idx" ON "public"."AlertDelivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AlertDelivery_status_claimedAt_idx" ON "public"."AlertDelivery"("status", "claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AlertDelivery_alertEventId_notifierId_eventAt_key" ON "public"."AlertDelivery"("alertEventId", "notifierId", "eventAt");

-- Monthly partitions, no DEFAULT: the last 92 days through 2 months ahead (UTC)
DO $$
DECLARE
  m timestamp := date_trunc('month', (now() - interval '92 days') AT TIME ZONE 'UTC');
  last_m timestamp := date_trunc('month', (now() + interval '2 months') AT TIME ZONE 'UTC');
BEGIN
  WHILE m <= last_m LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS "public".%I PARTITION OF "public"."AlertEvent" FOR VALUES FROM (%L) TO (%L)',
      'AlertEvent_p' || to_char(m, 'YYYYMM'), m AT TIME ZONE 'UTC', (m + interval '1 month') AT TIME ZONE 'UTC'
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS "public".%I PARTITION OF "public"."AlertDelivery" FOR VALUES FROM (%L) TO (%L)',
      'AlertDelivery_p' || to_char(m, 'YYYYMM'), m AT TIME ZONE 'UTC', (m + interval '1 month') AT TIME ZONE 'UTC'
    );
    m := m + interval '1 month';
  END LOOP;
END $$;
