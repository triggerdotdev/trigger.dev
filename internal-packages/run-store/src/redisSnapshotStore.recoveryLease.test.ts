import { containerTest, redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { setTimeout as sleep } from "node:timers/promises";
import { Registry } from "prom-client";
import { describe, expect, vi } from "vitest";
import { PendingIndex } from "./pendingIndex.js";
import {
  PendingRecoveryWorker,
  RecoverySweeper,
  type PostgresCommitStatus,
} from "./pendingRecoveryWorker.js";
import { RedisSnapshotStore, type SnapshotEntryInput } from "./redisSnapshotStore.js";
import { runToPartition } from "./snapshotKeys.js";
import { recoveryMetrics } from "./testFixtures/promMetrics.js";

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
      const expiryMarginMs = 50;
      const scanned: number[] = [];
      let markPartitionStarted!: () => void;
      const partitionStarted = new Promise<void>((resolve) => (markPartitionStarted = resolve));
      let releasePartition!: () => void;
      const partitionGate = new Promise<void>((resolve) => (releasePartition = resolve));
      const sweeperA = new RecoverySweeper({
        worker: {
          processPartition: async (partition) => {
            scanned.push(partition);
            markPartitionStarted();
            await partitionGate;
            return [];
          },
        },
        pendingIndex: {
          ensureAllGroups: async () => {},
          summary: async () => ({ count: 0, oldestMs: undefined }),
        },
        consumer: "A",
        partitionCount: 5,
        // Renews once a quarter TTL has passed, so the renewal before partition 1 is due and fails.
        leaseTtlMs: ttlMs,
        acquireTick: async () => store.acquireOrRenewRecoveryLease("owner-A", ttlMs),
      });
      const aTick = sweeperA.tick();
      try {
        await Promise.race([partitionStarted, aTick]);
        expect(scanned).toEqual([0]);
        // Start the expiry wait only after Redis granted A's lease, and hold partition 0 until B owns it.
        await sleep(ttlMs + expiryMarginMs);
        expect(await store.acquireOrRenewRecoveryLease("owner-B", 10_000)).toBe(true);
        // A finishes partition 0, its renew before partition 1 fails, and it stops there.
        releasePartition();
        const result = await aTick;
        expect(scanned).toEqual([0]); // A processed ONLY the in-flight partition, never advanced
        expect(result.skipped).toBe(false); // it did work before losing the lease
        // The successor still holds the lease; A cannot reclaim it while B renews.
        expect(await store.acquireOrRenewRecoveryLease("owner-A", ttlMs)).toBe(false);
      } finally {
        releasePartition();
        try {
          await aTick;
        } finally {
          await store.quit();
        }
      }
    }
  );
});

function snapshotEntry(runId: string, id: string): SnapshotEntryInput {
  return {
    id,
    runId,
    engine: "V2",
    executionStatus: "EXECUTING",
    description: "d",
    runStatus: "EXECUTING",
    createdAt: "2026-08-21T00:00:00.000Z",
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    projectId: "proj_1",
    organizationId: "org_1",
  };
}

// One exported sample of an unlabelled series, read from the registry's exposition text.
async function exported(register: Registry, name: string): Promise<number | undefined> {
  const line = (await register.metrics()).split("\n").find((l) => l.startsWith(`${name} `));
  return line === undefined ? undefined : Number(line.slice(name.length + 1));
}

describe("RecoverySweeper pending gauges and the recovery lease", () => {
  containerTest(
    "a sweep that loses the lease mid-sweep to a successor exports zero pending",
    async ({ redisOptions, prisma }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(raw);
      const register = new Registry();
      let releaseTx!: () => void;
      const txGate = new Promise<void>((resolve) => (releaseTx = resolve));
      let held: Promise<unknown> | undefined;
      try {
        // A unit whose Postgres transaction stays open: every sweep retries it, so it stays pending.
        const runId = "run_lease_gauges";
        await store.append({ entry: snapshotEntry(runId, "s0"), kind: "birth", isTerminal: false });
        let markReady!: (xid: string) => void;
        const ready = new Promise<string>((resolve) => (markReady = resolve));
        held = prisma.$transaction(
          async (tx) => {
            const rows = await tx.$queryRawUnsafe<Array<{ xid: string }>>(
              "SELECT pg_current_xact_id()::text AS xid"
            );
            markReady(rows[0].xid);
            await txGate;
          },
          { timeout: 30_000, maxWait: 10_000 }
        );
        const xid = await ready;
        const prepared = await store.prepare({
          protocolVersion: 1,
          transitionToken: "tok_1",
          postgresXid: xid,
          runId,
          organizationId: "org_1",
          residency: "mirrored",
          logicalRunStoreRoute: "logical:1",
          entries: [
            {
              entry: snapshotEntry(runId, "s1"),
              kind: "transition",
              isTerminal: false,
              expectedCur: "s0",
            },
          ],
          commitProbeSnapshotId: "s1",
        });
        expect(prepared.outcome).toBe("prepared");

        const { oldestMs } = await index.summary(runToPartition(runId));
        expect(oldestMs).toBeTypeOf("number");
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(oldestMs! + 1_000);

        const worker = new PendingRecoveryWorker({
          store,
          pendingIndex: index,
          checkPostgresCommit: async (xid8) => {
            const rows = await prisma.$queryRawUnsafe<Array<{ status: PostgresCommitStatus }>>(
              "SELECT pg_xact_status($1::xid8) AS status",
              xid8
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
        // A renews before every partition (an elapsed time is never below -Infinity), so it attempts a
        // renewal at partition 1 however fast Redis is. The renewal that starts the hand-over tick gives
        // the lease to the successor B first, so that renewal really fails in Redis and A loses the lease
        // mid-sweep, without depending on how long a sweep takes.
        const ttlMs = 60_000;
        let acquireCalls = 0;
        let handOverAtCall = Number.POSITIVE_INFINITY;
        let bOwns = false;
        const sweeperA = new RecoverySweeper({
          worker,
          pendingIndex: index,
          consumer: "A",
          metrics: recoveryMetrics(register),
          leaseTtlMs: ttlMs,
          leaseRenewIntervalMs: Number.NEGATIVE_INFINITY,
          acquireTick: async () => {
            if (++acquireCalls === handOverAtCall) {
              // A's lease is gone (released here, standing in for it lapsing) and B takes it over.
              await store.releaseRecoveryLease("owner-A");
              bOwns = await store.acquireOrRenewRecoveryLease("owner-B", 60_000);
            }
            return store.acquireOrRenewRecoveryLease("owner-A", ttlMs);
          },
        });

        // A holds the lease for a whole sweep and exports the pending unit.
        const first = await sweeperA.tick();
        expect(first.skipped).toBe(false);
        expect(first.outcomes).toEqual([{ kind: "retry", runId, reason: "in-progress" }]);
        expect(await exported(register, "snapshot_store_recovery_pending_count")).toBe(1);
        expect(
          await exported(register, "snapshot_store_recovery_oldest_pending_age_seconds")
        ).toBeGreaterThan(0);

        // A sweeps again: it acquires at partition 0, and B takes the lease before A's renewal at
        // partition 1.
        handOverAtCall = acquireCalls + 2;
        const result = await sweeperA.tick();
        expect(bOwns).toBe(true);
        expect(acquireCalls).toBe(handOverAtCall);
        // A scanned before it lost the lease, so the loss came at a renewal mid-sweep.
        expect(result.skipped).toBe(false);
        expect(await store.acquireOrRenewRecoveryLease("owner-A", ttlMs)).toBe(false);
        // A no longer holds the lease, so it exports no pending work, not the count from its last sweep.
        expect(await exported(register, "snapshot_store_recovery_pending_count")).toBe(0);
        expect(await exported(register, "snapshot_store_recovery_oldest_pending_age_seconds")).toBe(
          0
        );
        // The unit itself is still pending: only A's view of it was withdrawn.
        expect(await store.hasPreparedUnit(runId)).toBe(true);
      } finally {
        vi.useRealTimers();
        releaseTx();
        await held;
        await raw.quit();
        await store.quit();
      }
    }
  );
});
