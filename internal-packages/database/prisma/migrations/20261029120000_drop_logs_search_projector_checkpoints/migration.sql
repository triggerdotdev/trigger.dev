-- Fail fast if another transaction holds a lock on this projector-only table.
SET lock_timeout = '5s';

DROP TABLE IF EXISTS "public"."LogsSearchProjectorCheckpoint";

RESET lock_timeout;
