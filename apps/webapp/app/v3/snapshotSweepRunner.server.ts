import type { RedisClient } from "@internal/redis";
import { logger } from "~/services/logger.server";
import type { SweepPassOutcome, SweepRunner } from "./snapshotStoreBindings.server";

const LOCK_KEY = "snapshot-sweep:lock";

// Compare-and-delete. A bare DEL would let a pass that overran its own lock delete its SUCCESSOR's
// lock on release, and two passes would then run together — the failure the lock exists to prevent.
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

type SweepCounts = Record<string, number | boolean>;

export function buildSnapshotSweepRunner(deps: {
  client: RedisClient;
  sweep: (opts: { deadline: number; signal: AbortSignal }) => Promise<SweepCounts>;
  lockTtlMs: number;
  fence?: () => string;
}): SweepRunner {
  return async ({ deadline, signal }): Promise<SweepPassOutcome> => {
    // enqueueOnce gives no overlap protection: its dedup record IS the queue item and the ack
    // deletes it, so it elects a winner only at start-up. Nothing extends the visibility timeout
    // either, so a long pass is redelivered and would otherwise run beside itself.
    const fence =
      deps.fence?.() ?? `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const acquired = await deps.client.set(LOCK_KEY, fence, "PX", deps.lockTtlMs, "NX");

    if (acquired !== "OK") {
      return { outcome: "skipped_locked" };
    }

    try {
      const counts = await deps.sweep({ deadline, signal });

      if (signal.aborted) {
        return { outcome: "aborted", counts };
      }
      if (counts.partial === true) {
        return { outcome: "partial", counts };
      }
      return { outcome: "completed", counts };
    } catch (error) {
      logger.error("snapshot orphan sweep pass failed", { error });
      return { outcome: "failed" };
    } finally {
      await deps.client
        .eval(RELEASE_LUA, 1, LOCK_KEY, fence)
        .catch((error) => logger.warn("snapshot sweep lock release failed", { error }));
    }
  };
}
