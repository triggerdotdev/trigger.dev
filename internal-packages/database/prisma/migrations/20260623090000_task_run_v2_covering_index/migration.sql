-- Bring task_run_v2's run-list index to parity with TaskRun's
-- (TaskRun_runtimeEnvironmentId_createdAt_idx, added in migration
-- 20250611080322): add the INCLUDE (id) covering column and fillfactor 90 so the
-- dashboard run-list query keeps index-only scans and the same page packing once
-- v2 carries volume. Without this, v2 run-list reads do heap fetches the legacy
-- table avoids.
--
-- task_run_v2 is empty until an org cuts over to v2 run ids (gated on the native
-- realtime backend), and this migration deploys before any opt-in, so the
-- DROP/CREATE is effectively instant and runs safely inside the migration
-- transaction (no CONCURRENTLY needed, unlike the original TaskRun migration
-- which ran against a populated table).
DROP INDEX IF EXISTS "task_run_v2_runtimeEnvironmentId_createdAt_idx";

CREATE INDEX "task_run_v2_runtimeEnvironmentId_createdAt_idx" ON "task_run_v2"("runtimeEnvironmentId", "createdAt" DESC) INCLUDE ("id") WITH (fillfactor = 90);
