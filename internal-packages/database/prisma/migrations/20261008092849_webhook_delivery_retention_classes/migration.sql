DO $$
DECLARE
  publications text[];
  publication text;
  retention record;
  today date := (now() AT TIME ZONE 'utc')::date;
  lookahead_end date := (now() AT TIME ZONE 'utc')::date + 10;
  leaf_lo date;
  leaf_days int;
BEGIN
  SELECT coalesce(array_agg(p.pubname::text), '{}')
    INTO publications
    FROM pg_publication p
    JOIN pg_publication_rel r ON r.prpubid = p.oid
   WHERE r.prrelid = to_regclass('"public"."WebhookDelivery"');

  DROP TABLE IF EXISTS "public"."WebhookDelivery" CASCADE;

  CREATE TABLE IF NOT EXISTS "public"."WebhookDelivery" (
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
    "headers" JSONB,
    "rawBodyHash" TEXT,
    "errorMessage" TEXT,
    "filterReason" TEXT,
    "targets" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    "retentionDays" INTEGER NOT NULL DEFAULT 30,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id", "createdAt", "retentionDays")
  ) PARTITION BY LIST ("retentionDays");

  CREATE INDEX IF NOT EXISTS "WebhookDelivery_webhookEndpointId_createdAt_idx"
    ON "public"."WebhookDelivery" ("webhookEndpointId", "createdAt" DESC);

  FOR retention IN
    SELECT * FROM (VALUES (3, 'day'), (7, 'day'), (30, 'day'), (90, 'week'), (180, 'week'), (365, 'week'))
      AS classes(days, period)
  LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF "public"."WebhookDelivery" FOR VALUES IN (%s) PARTITION BY RANGE ("createdAt")',
      'WebhookDelivery_r' || retention.days,
      retention.days
    );

    IF retention.period = 'week' THEN
      leaf_lo := date_trunc('week', today)::date;
      leaf_days := 7;
    ELSE
      leaf_lo := today;
      leaf_days := 1;
    END IF;

    WHILE leaf_lo <= lookahead_end LOOP
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        'WebhookDelivery_r' || retention.days || '_' || to_char(leaf_lo, 'YYYY_MM_DD'),
        'WebhookDelivery_r' || retention.days,
        leaf_lo::timestamp,
        (leaf_lo + leaf_days)::timestamp
      );
      leaf_lo := leaf_lo + leaf_days;
    END LOOP;
  END LOOP;

  FOREACH publication IN ARRAY publications LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION %I ADD TABLE "public"."WebhookDelivery"', publication);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Could not re-add WebhookDelivery to publication %; the replication client adds it on start', publication;
    END;
  END LOOP;
END $$;
