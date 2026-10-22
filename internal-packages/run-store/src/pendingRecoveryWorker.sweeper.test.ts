// The sweeper's per-tick Redis cost and its lease handling, on real Redis with a real worker, pending
// index and fleet lease. Commands are counted with INFO commandstats (the test Redis is one node, so
// its counts cover every client), the gauges are read from a prom-client registry, and the partitions
// a sweep scanned are the ones whose consumer group knows the sweep's consumer.
import { containerTest } from "@internal/testcontainers";
import { createRedisClient, type RedisClient } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout as sleep } from "node:timers/promises";
import { Registry } from "prom-client";
import { describe, expect } from "vitest";
import { PendingIndex, RECOVERY_CONSUMER_GROUP } from "./pendingIndex.js";
import {
  PendingRecoveryWorker,
  RecoverySweeper,
  type PostgresCommitStatus,
} from "./pendingRecoveryWorker.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { PENDING_PARTITION_COUNT, pendingStreamKey, recoveryLeaseKey } from "./snapshotKeys.js";
import { metricValue, recoveryMetrics } from "./testFixtures/promMetrics.js";
import { callsBetween, commandCalls } from "./testFixtures/redisCommandStats.js";

type Rig = {
  store: RedisSnapshotStore;
  raw: RedisClient;
  index: PendingIndex;
  worker: PendingRecoveryWorker;
  quit: () => Promise<void>;
};

function rig(redisOptions: any, prisma: PrismaClient): Rig {
  const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
  const raw = createRedisClient(redisOptions, { onError: () => {} });
  const index = new PendingIndex(raw);
  const worker = new PendingRecoveryWorker({
    store,
    pendingIndex: index,
    checkPostgresCommit: async (xid) => {
      const rows = await prisma.$queryRawUnsafe<Array<{ status: PostgresCommitStatus }>>(
        "SELECT pg_xact_status($1::xid8) AS status",
        xid
      );
      return rows[0]?.status ?? null;
    },
    commitProbeExists: async (snapshotId) => {
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        'SELECT 1 FROM "TaskRunExecutionSnapshot" WHERE id = $1',
        snapshotId
      );
      return rows.length > 0;
    },
    quarantine: async (unit, reason) => {
      await store.quarantinePreparedUnit(unit, reason);
    },
  });
  return {
    store,
    raw,
    index,
    worker,
    quit: async () => {
      await raw.quit();
      await store.quit();
    },
  };
}

// Pending entries for runs with nothing prepared: the worker settles each as already resolved. With a
// per-partition read count of one, a tick settles one entry per partition and leaves the rest pending.
async function addEntries(raw: RedisClient, partition: number, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await raw.xadd(pendingStreamKey(partition), "*", "runId", `run_gone_${partition}_${i}`);
  }
}

// The partitions whose consumer group knows `consumer`: the ones a sweep as that consumer read.
async function scannedPartitions(
  raw: RedisClient,
  consumer: string,
  partitionCount: number
): Promise<number[]> {
  const scanned: number[] = [];
  for (let partition = 0; partition < partitionCount; partition++) {
    let consumers: unknown[] = [];
    try {
      consumers = (await raw.xinfo(
        "CONSUMERS",
        pendingStreamKey(partition),
        RECOVERY_CONSUMER_GROUP
      )) as unknown[];
    } catch (error) {
      // No stream or no group yet: nothing read this partition.
      if (!(error instanceof Error) || !/no such key|NOGROUP/i.test(error.message)) throw error;
    }
    const names = consumers.map((c) => {
      const flat = c as string[];
      return flat[flat.indexOf("name") + 1];
    });
    if (names.includes(consumer)) scanned.push(partition);
  }
  return scanned;
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

describe("RecoverySweeper summary", () => {
  containerTest(
    "reads no partition summary without a metrics sink",
    async ({ redisOptions, prisma }) => {
      const r = rig(redisOptions, prisma);
      try {
        await addEntries(r.raw, 1, 2);
        await addEntries(r.raw, 4, 2);
        const sweeper = new RecoverySweeper({
          worker: r.worker,
          pendingIndex: r.index,
          consumer: "sweeper",
          partitionCount: 8,
          count: 1,
        });

        const before = await commandCalls(r.raw);
        const result = await sweeper.tick();
        const after = await commandCalls(r.raw);

        expect(result.skipped).toBe(false);
        expect(result.outcomes.map((o) => o.kind)).toEqual([
          "already-resolved",
          "already-resolved",
        ]);
        expect(await scannedPartitions(r.raw, "sweeper", 9)).toEqual(range(8));
        // The summary is one XLEN and one XRANGE per partition; nothing consumes it, so none ran.
        expect(callsBetween(before, after, "xlen")).toBe(0);
        expect(callsBetween(before, after, "xrange")).toBe(0);
      } finally {
        await r.quit();
      }
    }
  );

  containerTest(
    "reads one summary per partition and records the pending gauges with a metrics sink",
    async ({ redisOptions, prisma }) => {
      const r = rig(redisOptions, prisma);
      const register = new Registry();
      try {
        await addEntries(r.raw, 1, 3);
        await addEntries(r.raw, 4, 2);
        await sleep(50);
        const sweeper = new RecoverySweeper({
          worker: r.worker,
          pendingIndex: r.index,
          consumer: "sweeper",
          partitionCount: 8,
          count: 1,
          metrics: recoveryMetrics(register),
        });

        const before = await commandCalls(r.raw);
        await sweeper.tick();
        const after = await commandCalls(r.raw);

        expect(callsBetween(before, after, "xlen")).toBe(8);
        expect(callsBetween(before, after, "xrange")).toBe(8);
        // One entry settled per partition: two left in partition 1, one in partition 4.
        expect(await metricValue(register, "snapshot_store_recovery_pending_count")).toBe(3);
        expect(
          await metricValue(register, "snapshot_store_recovery_oldest_pending_age_seconds")
        ).toBeGreaterThanOrEqual(0.05);
        expect(await metricValue(register, "snapshot_store_recovery_sweep_seconds_count")).toBe(1);
        expect(
          await metricValue(register, "snapshot_store_recovery_outcome_total", {
            kind: "already-resolved",
          })
        ).toBe(2);
      } finally {
        await r.quit();
      }
    }
  );
});

describe("RecoverySweeper pending gauges and the lease", () => {
  containerTest(
    "records the scanned values while it holds the lease, then zero once a successor holds it",
    async ({ redisOptions, prisma }) => {
      const r = rig(redisOptions, prisma);
      const register = new Registry();
      try {
        await addEntries(r.raw, 1, 3);
        const ttlMs = 100;
        const sweeper = new RecoverySweeper({
          worker: r.worker,
          pendingIndex: r.index,
          consumer: "A",
          partitionCount: 8,
          count: 1,
          metrics: recoveryMetrics(register),
          leaseTtlMs: ttlMs,
          acquireTick: () => r.store.acquireOrRenewRecoveryLease("owner-A", ttlMs),
        });

        expect((await sweeper.tick()).skipped).toBe(false);
        expect(await metricValue(register, "snapshot_store_recovery_pending_count")).toBe(2);

        // A's lease lapses and B takes it before A's next tick.
        await sleep(ttlMs + 50);
        expect(await r.store.acquireOrRenewRecoveryLease("owner-B", 60_000)).toBe(true);

        const before = await commandCalls(r.raw);
        expect(await sweeper.tick()).toEqual({ skipped: true, outcomes: [] });
        const after = await commandCalls(r.raw);
        // A read no partition, and exports no pending work rather than its last sweep's count.
        expect(callsBetween(before, after, "xreadgroup")).toBe(0);
        expect(callsBetween(before, after, "xlen")).toBe(0);
        expect(await metricValue(register, "snapshot_store_recovery_pending_count")).toBe(0);
        expect(
          await metricValue(register, "snapshot_store_recovery_oldest_pending_age_seconds")
        ).toBe(0);
        expect(await r.raw.xlen(pendingStreamKey(1))).toBe(2);
      } finally {
        await r.quit();
      }
    }
  );
});

// Each lease acquire or renewal is one EVAL. No entry is pending in these sweeps, so nothing else the
// sweep does is an EVAL (a settle is, but only for a delivered entry).
describe("RecoverySweeper lease renewal", () => {
  containerTest(
    "a fast sweep under the 15 s default renews only at the start",
    async ({ redisOptions, prisma }) => {
      const r = rig(redisOptions, prisma);
      try {
        const sweeper = new RecoverySweeper({
          worker: r.worker,
          pendingIndex: r.index,
          consumer: "A",
          acquireTick: () => r.store.acquireOrRenewRecoveryLease("owner-A", 60_000),
        });
        const before = await commandCalls(r.raw);
        const result = await sweeper.tick();
        const after = await commandCalls(r.raw);
        expect(result.skipped).toBe(false);
        expect(await scannedPartitions(r.raw, "A", PENDING_PARTITION_COUNT)).toEqual(
          range(PENDING_PARTITION_COUNT)
        );
        expect(callsBetween(before, after, "eval")).toBe(1);
      } finally {
        await r.quit();
      }
    }
  );

  // Consecutive renewals are more than the interval apart, so a sweep of T ms renews at most
  // 1 + T / interval times, however many partitions it scans; a sweep several intervals long renews
  // at least once after the start.
  containerTest(
    "takes the lease at the start, then renews only once the renew interval has passed",
    async ({ redisOptions, prisma }) => {
      const r = rig(redisOptions, prisma);
      try {
        const intervalMs = 5;
        const sweeper = new RecoverySweeper({
          worker: r.worker,
          pendingIndex: r.index,
          consumer: "A",
          leaseRenewIntervalMs: intervalMs,
          acquireTick: () => r.store.acquireOrRenewRecoveryLease("owner-A", 60_000),
        });
        const before = await commandCalls(r.raw);
        const started = Date.now();
        await sweeper.tick();
        const elapsedMs = Date.now() - started;
        const renewals = callsBetween(before, await commandCalls(r.raw), "eval");

        expect(elapsedMs).toBeGreaterThanOrEqual(4 * intervalMs);
        expect(renewals).toBeGreaterThanOrEqual(2);
        expect(renewals).toBeLessThanOrEqual(1 + elapsedMs / intervalMs);
        expect(renewals).toBeLessThan(PENDING_PARTITION_COUNT);
      } finally {
        await r.quit();
      }
    }
  );

  containerTest(
    "derives the renew interval from the lease TTL (a quarter of it)",
    async ({ redisOptions, prisma }) => {
      const r = rig(redisOptions, prisma);
      try {
        const ttlMs = 20;
        const sweeper = new RecoverySweeper({
          worker: r.worker,
          pendingIndex: r.index,
          consumer: "A",
          leaseTtlMs: ttlMs,
          acquireTick: () => r.store.acquireOrRenewRecoveryLease("owner-A", ttlMs),
        });
        const before = await commandCalls(r.raw);
        const started = Date.now();
        const result = await sweeper.tick();
        const elapsedMs = Date.now() - started;
        const renewals = callsBetween(before, await commandCalls(r.raw), "eval");

        // Renewing every quarter TTL keeps the lease through the whole sweep.
        expect(result.skipped).toBe(false);
        expect(await scannedPartitions(r.raw, "A", PENDING_PARTITION_COUNT)).toEqual(
          range(PENDING_PARTITION_COUNT)
        );
        expect(elapsedMs).toBeGreaterThanOrEqual(ttlMs);
        expect(renewals).toBeGreaterThanOrEqual(2);
        expect(renewals).toBeLessThanOrEqual(1 + elapsedMs / (ttlMs / 4));
      } finally {
        await r.quit();
      }
    }
  );

  containerTest(
    "a failed mid-sweep renewal stops before the next partition",
    async ({ redisOptions, prisma }) => {
      const r = rig(redisOptions, prisma);
      try {
        // A renews before every partition (an elapsed time is never below -Infinity), so it attempts a
        // renewal at partition 1 however fast Redis is. Before that renewal B takes the lease, so the
        // renewal really fails in Redis, without depending on how long a sweep takes.
        let acquireCalls = 0;
        let bOwns = false;
        const sweeper = new RecoverySweeper({
          worker: r.worker,
          pendingIndex: r.index,
          consumer: "A",
          leaseTtlMs: 60_000,
          leaseRenewIntervalMs: Number.NEGATIVE_INFINITY,
          acquireTick: async () => {
            if (++acquireCalls === 2) {
              // A's lease is gone (released here, standing in for it lapsing) and B takes it over.
              await r.store.releaseRecoveryLease("owner-A");
              bOwns = await r.store.acquireOrRenewRecoveryLease("owner-B", 60_000);
            }
            return r.store.acquireOrRenewRecoveryLease("owner-A", 60_000);
          },
        });
        const result = await sweeper.tick();
        expect(bOwns).toBe(true);
        expect(acquireCalls).toBe(2);
        expect(result.skipped).toBe(false);

        // A read the partition before the renewal that failed and none after it.
        const scanned = await scannedPartitions(r.raw, "A", PENDING_PARTITION_COUNT);
        expect(scanned).toEqual([0]);
        expect(await r.raw.get(recoveryLeaseKey())).toBe("owner-B");
      } finally {
        await r.quit();
      }
    }
  );
});

describe("RecoverySweeper stop", () => {
  containerTest(
    "returns a promise that settles once the lease is released",
    async ({ redisOptions, prisma }) => {
      const r = rig(redisOptions, prisma);
      try {
        const sweeper = new RecoverySweeper({
          worker: r.worker,
          pendingIndex: r.index,
          consumer: "A",
          partitionCount: 1,
          acquireTick: () => r.store.acquireOrRenewRecoveryLease("owner-A", 60_000),
          releaseTick: () => r.store.releaseRecoveryLease("owner-A"),
        });
        expect((await sweeper.tick()).skipped).toBe(false);
        expect(await r.raw.get(recoveryLeaseKey())).toBe("owner-A");

        await sweeper.stop();
        expect(await r.raw.get(recoveryLeaseKey())).toBeNull();
        expect(await sweeper.tick()).toEqual({ skipped: true, outcomes: [] });
        expect(await r.store.acquireOrRenewRecoveryLease("owner-B", 60_000)).toBe(true);
      } finally {
        await r.quit();
      }
    }
  );

  containerTest(
    "a failed release never rejects the stop promise",
    async ({ redisOptions, prisma }) => {
      const r = rig(redisOptions, prisma);
      const closed = createRedisClient(redisOptions, { onError: () => {} });
      const unreachable = new RedisSnapshotStore({ client: closed, completedTtlMs: 60_000 });
      try {
        await closed.quit();
        await expect(unreachable.releaseRecoveryLease("owner-A")).rejects.toThrow(
          /Connection is closed/
        );
        const sweeper = new RecoverySweeper({
          worker: r.worker,
          pendingIndex: r.index,
          consumer: "A",
          releaseTick: () => unreachable.releaseRecoveryLease("owner-A"),
        });
        await expect(sweeper.stop()).resolves.toBeUndefined();
      } finally {
        await r.quit();
      }
    }
  );
});
