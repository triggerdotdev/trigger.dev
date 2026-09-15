import { redisTest } from "@internal/testcontainers";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect } from "vitest";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { RecoverySweeper } from "./pendingRecoveryWorker.js";

// The single-fleet recovery lease, proven on real Redis: exactly one owner holds it, takeover happens
// after expiry, and a former owner can never renew or release a successor's lease (compare-owner).
describe("RedisSnapshotStore recovery lease", () => {
  redisTest("one owner holds it; a second acquirer is refused", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      expect(await store.acquireOrRenewRecoveryLease("owner-a", 10_000)).toBe(true);
      // A second pod cannot acquire while A holds it.
      expect(await store.acquireOrRenewRecoveryLease("owner-b", 10_000)).toBe(false);
      // A renews (still owns) — B still refused.
      expect(await store.acquireOrRenewRecoveryLease("owner-a", 10_000)).toBe(true);
      expect(await store.acquireOrRenewRecoveryLease("owner-b", 10_000)).toBe(false);
    } finally {
      await store.quit();
    }
  });

  redisTest("a successor takes over after the holder's lease expires", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      expect(await store.acquireOrRenewRecoveryLease("owner-a", 300)).toBe(true);
      expect(await store.acquireOrRenewRecoveryLease("owner-b", 300)).toBe(false);
      await sleep(500); // A's lease expires
      // B now acquires the vacated lease.
      expect(await store.acquireOrRenewRecoveryLease("owner-b", 10_000)).toBe(true);
      // The former owner A can no longer renew: B holds it.
      expect(await store.acquireOrRenewRecoveryLease("owner-a", 10_000)).toBe(false);
    } finally {
      await store.quit();
    }
  });

  redisTest("a former owner cannot release a successor's lease", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      expect(await store.acquireOrRenewRecoveryLease("owner-a", 200)).toBe(true);
      await sleep(400);
      expect(await store.acquireOrRenewRecoveryLease("owner-b", 10_000)).toBe(true);
      // A's release is a no-op (compare-owner): B still owns it afterward.
      await store.releaseRecoveryLease("owner-a");
      expect(await store.acquireOrRenewRecoveryLease("owner-c", 10_000)).toBe(false);
      // B's own release frees it.
      await store.releaseRecoveryLease("owner-b");
      expect(await store.acquireOrRenewRecoveryLease("owner-c", 10_000)).toBe(true);
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "a sweep that outlives its lease stops before the next partition once a successor takes over",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const ttlMs = 200;
      const scanned: number[] = [];
      // A slow partition worker (300ms > the 200ms lease TTL) so the sweep outlives the lease; the
      // pendingIndex is a no-op double. Only the lease (real Redis) is under test here.
      const sweeperA = new RecoverySweeper({
        worker: {
          processPartition: async (partition) => {
            scanned.push(partition);
            await sleep(300);
            return [];
          },
        },
        pendingIndex: {
          ensureAllGroups: async () => {},
          summary: async () => ({ count: 0, oldestMs: undefined }),
        },
        consumer: "A",
        partitionCount: 5,
        acquireTick: async () => store.acquireOrRenewRecoveryLease("owner-A", ttlMs),
      });
      try {
        // A renews before partition 0, then processes it for 300ms, outliving its 200ms lease.
        const aTick = sweeperA.tick();
        // Mid partition-0, after A's lease has expired, a successor takes over.
        await sleep(250);
        expect(await store.acquireOrRenewRecoveryLease("owner-B", 10_000)).toBe(true);
        // A finishes partition 0, its renew before partition 1 fails, and it stops there.
        const result = await aTick;
        expect(scanned).toEqual([0]); // A processed ONLY the in-flight partition, never advanced
        expect(result.skipped).toBe(false); // it did work before losing the lease
        // The successor still holds the lease; A cannot reclaim it while B renews.
        expect(await store.acquireOrRenewRecoveryLease("owner-A", ttlMs)).toBe(false);
      } finally {
        await store.quit();
      }
    }
  );
});
