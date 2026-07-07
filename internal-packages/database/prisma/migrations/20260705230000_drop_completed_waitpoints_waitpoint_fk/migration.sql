-- Run-ops split: drop the _completedWaitpoints -> Waitpoint FK so a LEGACY snapshot can record a
-- cross-DB completed token (NEW-resident). Third of the split's waitpoint-FK drops; the A (snapshot)
-- side stays same-DB. Referential integrity is app-enforced, matching the sibling FK-removals.

-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey";
