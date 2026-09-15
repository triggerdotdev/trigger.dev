-- Run-ops split: allow a cross-DB token connection (a LEGACY run blocking on a NEW-resident token,
-- whose Waitpoint row lives on the other database). Matches the split's control-plane FK-removal pattern.

-- Fail fast instead of queueing behind a long txn/VACUUM for the ACCESS EXCLUSIVE lock.
SET lock_timeout = '5s';

ALTER TABLE "_WaitpointRunConnections" DROP CONSTRAINT IF EXISTS "_WaitpointRunConnections_B_fkey";
