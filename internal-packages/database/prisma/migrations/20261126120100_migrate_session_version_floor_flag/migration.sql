-- Copy each environment's staff-set floor (Organization.featureFlags.sessionVersionFloor[<envId>].minVersion)
-- into that environment's skew protection threshold. Environments that already have thresholds are left
-- alone, so a re-run is a no-op.
UPDATE "RuntimeEnvironment" AS e
SET "skewProtectionThresholds" = jsonb_build_object(
  'environment', jsonb_build_object(
    'version', f.value ->> 'minVersion',
    'setAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'setBy', jsonb_build_object('type', 'migrated')
  )
)
FROM "Organization" AS o
CROSS JOIN LATERAL jsonb_each(
  CASE
    WHEN jsonb_typeof(o."featureFlags" -> 'sessionVersionFloor') = 'object'
      THEN o."featureFlags" -> 'sessionVersionFloor'
    ELSE '{}'::jsonb
  END
) AS f
WHERE e."organizationId" = o."id"
  AND e."id" = f.key
  AND e."skewProtectionThresholds" IS NULL
  AND jsonb_typeof(f.value) = 'object'
  -- Only a string: the flag's reader ignored any other type, so a number was never a floor.
  AND jsonb_typeof(f.value -> 'minVersion') = 'string'
  AND f.value ->> 'minVersion' <> '';
