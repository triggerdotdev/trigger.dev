-- Run-ops split: drop the TaskRunWaitpoint -> Waitpoint FK so a LEGACY run's blocking edge can point
-- at a NEW-resident (cross-DB) token. The #new dedicated schema is already FK-free here; this aligns
-- #legacy. Referential integrity is app-enforced, matching the split's control-plane FK-removal.
ALTER TABLE "TaskRunWaitpoint" DROP CONSTRAINT IF EXISTS "TaskRunWaitpoint_waitpointId_fkey";
