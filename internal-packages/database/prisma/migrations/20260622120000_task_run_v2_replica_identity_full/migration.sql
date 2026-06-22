-- task_run_v2 is co-published to ClickHouse alongside TaskRun via logical
-- replication. Replication needs REPLICA IDENTITY FULL so UPDATE/DELETE WAL
-- events carry the full OLD row (organizationId, environmentType, ...) that the
-- ClickHouse transform requires. Without it, a v2 run DELETE ships only the
-- primary key, organizationId is undefined, and the run's ClickHouse
-- soft-delete tombstone is silently dropped (the deleted run lingers in
-- analytics). TaskRun is configured the same way; this pins it deterministically
-- for task_run_v2 rather than relying on an out-of-band ops step.
ALTER TABLE "public"."task_run_v2" REPLICA IDENTITY FULL;
