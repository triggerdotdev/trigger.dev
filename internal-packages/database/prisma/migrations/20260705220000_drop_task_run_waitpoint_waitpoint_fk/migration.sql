-- Run-ops split: drop the TaskRunWaitpoint -> Waitpoint FK so a LEGACY run's blocking edge can point
-- at a NEW-resident (cross-DB) token. The #new dedicated schema is already FK-free here; this aligns
-- #legacy. Referential integrity is app-enforced, matching the split's control-plane FK-removal.

-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

ALTER TABLE "TaskRunWaitpoint" DROP CONSTRAINT IF EXISTS "TaskRunWaitpoint_waitpointId_fkey";
