-- Seed the snapshotStoreOrgDials cohort map from the current enrolled cohort, so presence-as-latch
-- holds for orgs enabled before this ships. Enrolled orgs seed with their current mode; latch-only
-- orgs (ever-enabled but rolled back to off) seed as "off". Guarantees the row always exists so the
-- route's atomic UPDATE never hits zero rows on a configured deploy. Idempotent via ON CONFLICT.
INSERT INTO "FeatureFlag" ("id", "key", "value", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'snapshotStoreOrgDials',
  COALESCE((
    SELECT jsonb_object_agg("id", COALESCE("featureFlags"->>'snapshotStoreOrgMode', 'off'))
    FROM "Organization"
    WHERE "featureFlags" ? 'snapshotStoreOrgMode' OR "featureFlags" ? 'snapshotStoreOrgEverEnabled'
  ), '{}'::jsonb),
  now(), now()
)
ON CONFLICT ("key") DO NOTHING;
