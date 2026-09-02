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

// The release is a WRITE, so the fault that fails a pass fails the release too; a single attempt
// then leaks the lock to its full TTL (budget + 2h), stalling every sweep for hours after a blip.
// Retry over a short window so a Redis that recovers frees the lock promptly; the TTL is the backstop.
const DEFAULT_RELEASE_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

type SweepCounts = Record<string, number | boolean>;

async function releaseLock(
  client: RedisClient,
  fence: string,
  retryDelaysMs: number[]
): Promise<void> {
  // attempts = retryDelaysMs.length + 1. A successful eval ends it, whether it deleted our lock
  // (returned 1) or found the fence no longer ours (returned 0) — both mean nothing more to do.
  for (let attempt = 0; ; attempt++) {
    try {
      await client.eval(RELEASE_LUA, 1, LOCK_KEY, fence);
      return;
    } catch (error) {
      if (attempt >= retryDelaysMs.length) {
        logger.warn(
          "snapshot sweep lock release failed after retries; lock will clear on its TTL",
          { error }
        );
        return;
      }
      await sleep(retryDelaysMs[attempt]);
    }
  }
}

export function buildSnapshotSweepRunner(deps: {
  client: RedisClient;
  sweep: (opts: { deadline: number; signal: AbortSignal }) => Promise<SweepCounts>;
  lockTtlMs: number;
  fence?: () => string;
  /** Backoff between release attempts. Defaults to a bounded ~16s ramp; tests pass short delays. */
  releaseRetryDelaysMs?: number[];
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
      if (signal.aborted) {
        return { outcome: "aborted" };
      }
      logger.error("snapshot orphan sweep pass failed", { error });
      return { outcome: "failed" };
    } finally {
      await releaseLock(
        deps.client,
        fence,
        deps.releaseRetryDelaysMs ?? DEFAULT_RELEASE_RETRY_DELAYS_MS
      );
    }
  };
}
