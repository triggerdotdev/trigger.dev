// M4: the recovery worker resolves interrupted prepared transitions by their REAL Postgres commit
// outcome. Real Redis (prepare/finalize) + real Postgres (committed/aborted/in-progress xids from
// actual transactions). No mocks: checkPostgresCommit / commitProbeExists run real SQL. This is the
// kill-mid-transition -> recover validation at the primitive level.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import {
  RedisSnapshotStore,
  type PreparedEntry,
  type PreparedPgUnit,
  type SnapshotEntryInput,
} from "./redisSnapshotStore.js";
import { PendingIndex, RECOVERY_CONSUMER_GROUP } from "./pendingIndex.js";
import {
  PendingRecoveryWorker,
  RecoverySweeper,
  RouteUnavailableError,
  type PostgresCommitStatus,
  type QuarantineReason,
  type RecoveryDeps,
} from "./pendingRecoveryWorker.js";
import { pendingStreamKey, runToPartition } from "./snapshotKeys.js";

function entry(
  over: Partial<SnapshotEntryInput> & { id: string; runId: string }
): SnapshotEntryInput {
  return {
    engine: "V2",
    executionStatus: "EXECUTING",
    description: "d",
    runStatus: "EXECUTING",
    createdAt: "2026-08-21T00:00:00.000Z",
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    projectId: "proj_1",
    organizationId: "org_1",
    ...over,
  };
}

function staged(runId: string, id: string, over: Partial<PreparedEntry> = {}): PreparedEntry {
  return { entry: entry({ id, runId }), kind: "transition", isTerminal: false, ...over };
}

function unit(
  runId: string,
  postgresXid: string,
  over: Partial<PreparedPgUnit> = {}
): PreparedPgUnit {
  return {
    protocolVersion: 1,
    transitionToken: "tok_1",
    postgresXid,
    runId,
    organizationId: "org_1",
    residency: "mirrored",
    logicalRunStoreRoute: "logical:1",
    entries: [staged(runId, "s1", { expectedCur: "s0" })],
    ...over,
  };
}

async function bornRun(store: RedisSnapshotStore, runId: string): Promise<void> {
  await store.append({ entry: entry({ id: "s0", runId }), kind: "birth", isTerminal: false });
}

// A real committed xid: pg_current_xact_id assigns a permanent xid and the implicit tx commits.
async function committedXid(prisma: PrismaClient): Promise<string> {
  const rows = (await prisma.$queryRawUnsafe(`SELECT pg_current_xact_id()::text AS xid`)) as Array<{
    xid: string;
  }>;
  return rows[0].xid;
}

// A real aborted xid: assign an xid inside a tx, then roll back by throwing out of it.
async function abortedXid(prisma: PrismaClient): Promise<string> {
  let xid = "";
  try {
    await prisma.$transaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(`SELECT pg_current_xact_id()::text AS xid`)) as Array<{
        xid: string;
      }>;
      xid = rows[0].xid;
      throw new Error("__rollback__");
    });
  } catch (e) {
    if (!(e instanceof Error && e.message === "__rollback__")) throw e;
  }
  return xid;
}

// Hold a real transaction open (its xid stays 'in progress') while `fn` runs against another conn.
async function withInProgressXid(
  prisma: PrismaClient,
  fn: (xid: string) => Promise<void>
): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  let markReady!: () => void;
  const ready = new Promise<void>((res) => (markReady = res));
  let xid = "";
  const txPromise = prisma.$transaction(
    async (tx) => {
      const rows = (await tx.$queryRawUnsafe(`SELECT pg_current_xact_id()::text AS xid`)) as Array<{
        xid: string;
      }>;
      xid = rows[0].xid;
      markReady();
      await gate;
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
  await ready;
  try {
    await fn(xid);
  } finally {
    release();
    await txPromise;
  }
}

// checkPostgresCommit wired to REAL SQL on the (single test) Postgres primary.
function realCheck(prisma: PrismaClient) {
  return async (xid8: string): Promise<PostgresCommitStatus> => {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT pg_xact_status($1::xid8) AS status`,
      xid8
    )) as Array<{ status: string | null }>;
    return rows[0].status as PostgresCommitStatus;
  };
}

// commitProbeExists wired to REAL SQL: a dedicated probe table stands in for the TRES point-read.
async function ensureProbeTable(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS snap_commit_probe (id text primary key)`
  );
}
function realProbe(prisma: PrismaClient) {
  return async (snapshotId: string): Promise<boolean> => {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM snap_commit_probe WHERE id = $1`,
      snapshotId
    )) as unknown[];
    return rows.length > 0;
  };
}

type Harness = {
  store: RedisSnapshotStore;
  index: PendingIndex;
  quarantined: Array<{ unit: PreparedPgUnit; reason: QuarantineReason }>;
  deps: (over?: Partial<RecoveryDeps>) => RecoveryDeps;
  worker: (over?: Partial<RecoveryDeps>) => PendingRecoveryWorker;
};

function harness(redisOptions: any, prisma: PrismaClient): Harness {
  const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
  const raw = createRedisClient(redisOptions, { onError: () => {} });
  const index = new PendingIndex(raw);
  const quarantined: Array<{ unit: PreparedPgUnit; reason: QuarantineReason }> = [];
  const base: RecoveryDeps = {
    store,
    pendingIndex: index,
    checkPostgresCommit: realCheck(prisma),
    commitProbeExists: realProbe(prisma),
    quarantine: async (u, reason) => {
      quarantined.push({ unit: u, reason });
    },
  };
  const deps = (over?: Partial<RecoveryDeps>) => ({ ...base, ...over });
  return {
    store,
    index,
    quarantined,
    deps,
    worker: (over?: Partial<RecoveryDeps>) => new PendingRecoveryWorker(deps(over)),
  };
}

describe("PendingRecoveryWorker", () => {
  containerTest(
    "a committed Postgres tx => finalize (published, pending cleared, XACKed)",
    async ({ redisOptions, prisma }) => {
      const h = harness(redisOptions, prisma);
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const runId = "run_rec_committed";
        const partition = runToPartition(runId);
        await h.index.ensureGroup(partition);
        await bornRun(h.store, runId);
        const xid = await committedXid(prisma);
        expect((await h.store.prepare(unit(runId, xid))).outcome).toBe("prepared");

        const outcomes = await h.worker().processPartition(partition, "w1");
        expect(outcomes).toEqual([{ kind: "finalized", runId }]);

        // Published: head advanced to the staged entry. Pending cleared. Stream + PEL empty (XACKed).
        expect((await h.store.getLatest(runId))?.id).toBe("s1");
        expect(await h.store.hasPreparedUnit(runId)).toBe(false);
        const pending = (await raw.xpending(
          pendingStreamKey(partition),
          RECOVERY_CONSUMER_GROUP
        )) as unknown[];
        expect(pending[0]).toBe(0);
      } finally {
        await raw.quit();
        await h.store.quit();
      }
    }
  );

  containerTest(
    "an aborted Postgres tx => abort (pending cleared, run-state unchanged)",
    async ({ redisOptions, prisma }) => {
      const h = harness(redisOptions, prisma);
      try {
        const runId = "run_rec_aborted";
        const partition = runToPartition(runId);
        await h.index.ensureGroup(partition);
        await bornRun(h.store, runId);
        const xid = await abortedXid(prisma);
        expect((await h.store.prepare(unit(runId, xid))).outcome).toBe("prepared");

        const outcomes = await h.worker().processPartition(partition, "w1");
        expect(outcomes).toEqual([{ kind: "aborted", runId }]);

        // Run-state unchanged: head still the committed birth, staged entry never published.
        expect((await h.store.getLatest(runId))?.id).toBe("s0");
        expect(await h.store.getById(runId, "s1")).toBeNull();
        expect(await h.store.hasPreparedUnit(runId)).toBe(false);
      } finally {
        await h.store.quit();
      }
    }
  );

  containerTest(
    "an in-progress Postgres tx => leave pending (no finalize/abort) and re-deliver",
    async ({ redisOptions, prisma }) => {
      const h = harness(redisOptions, prisma);
      try {
        const runId = "run_rec_inprogress";
        const partition = runToPartition(runId);
        await h.index.ensureGroup(partition);
        await bornRun(h.store, runId);

        await withInProgressXid(prisma, async (xid) => {
          expect((await h.store.prepare(unit(runId, xid))).outcome).toBe("prepared");
          const first = await h.worker().processPartition(partition, "w1");
          expect(first).toEqual([{ kind: "retry", runId, reason: "in-progress" }]);
          // Neither finalized nor aborted: still pending, head unchanged.
          expect(await h.store.hasPreparedUnit(runId)).toBe(true);
          expect((await h.store.getLatest(runId))?.id).toBe("s0");
          // Re-delivered on the next pass (reclaimed from this consumer's own pending list).
          const second = await h.worker().processPartition(partition, "w1", { minIdleMs: 0 });
          expect(second).toEqual([{ kind: "retry", runId, reason: "in-progress" }]);
        });
      } finally {
        await h.store.quit();
      }
    }
  );

  containerTest(
    "null status + MIRRORED with commit-probe row PRESENT => finalize",
    async ({ redisOptions, prisma }) => {
      const h = harness(redisOptions, prisma);
      try {
        await ensureProbeTable(prisma);
        const runId = "run_rec_null_present";
        const partition = runToPartition(runId);
        await h.index.ensureGroup(partition);
        await bornRun(h.store, runId);
        const probeId = "probe_present_1";
        await prisma.$executeRawUnsafe(
          `INSERT INTO snap_commit_probe (id) VALUES ($1) ON CONFLICT DO NOTHING`,
          probeId
        );
        await h.store.prepare(
          unit(runId, "999", { residency: "mirrored", commitProbeSnapshotId: probeId })
        );

        const outcomes = await h
          .worker({ checkPostgresCommit: async () => null })
          .processPartition(partition, "w1");
        expect(outcomes).toEqual([{ kind: "finalized", runId }]);
        expect((await h.store.getLatest(runId))?.id).toBe("s1");
      } finally {
        await h.store.quit();
      }
    }
  );

  containerTest(
    "null status + MIRRORED with commit-probe row ABSENT => abort",
    async ({ redisOptions, prisma }) => {
      const h = harness(redisOptions, prisma);
      try {
        await ensureProbeTable(prisma);
        const runId = "run_rec_null_absent";
        const partition = runToPartition(runId);
        await h.index.ensureGroup(partition);
        await bornRun(h.store, runId);
        await h.store.prepare(
          unit(runId, "999", { residency: "mirrored", commitProbeSnapshotId: "probe_absent_1" })
        );

        const outcomes = await h
          .worker({ checkPostgresCommit: async () => null })
          .processPartition(partition, "w1");
        expect(outcomes).toEqual([{ kind: "aborted", runId }]);
        expect((await h.store.getLatest(runId))?.id).toBe("s0");
        expect(await h.store.hasPreparedUnit(runId)).toBe(false);
      } finally {
        await h.store.quit();
      }
    }
  );

  containerTest(
    "null status + REDIS-PRIMARY => quarantined (NOT aborted, stays pending)",
    async ({ redisOptions, prisma }) => {
      const h = harness(redisOptions, prisma);
      try {
        const runId = "run_rec_null_redisprimary";
        const partition = runToPartition(runId);
        await h.index.ensureGroup(partition);
        await bornRun(h.store, runId);
        await h.store.prepare(unit(runId, "999", { residency: "redis-primary" }));

        const outcomes = await h
          .worker({ checkPostgresCommit: async () => null })
          .processPartition(partition, "w1");
        expect(outcomes).toEqual([{ kind: "quarantined", runId, reason: "redis-primary-null" }]);
        expect(h.quarantined.map((q) => q.reason)).toEqual(["redis-primary-null"]);
        // Fail closed: never aborted, the prepared unit stays for explicit recovery.
        expect(await h.store.hasPreparedUnit(runId)).toBe(true);
      } finally {
        await h.store.quit();
      }
    }
  );

  containerTest(
    "a connection error from checkPostgresCommit => retryable, NOT quarantined",
    async ({ redisOptions, prisma }) => {
      const h = harness(redisOptions, prisma);
      try {
        const runId = "run_rec_conn_error";
        const partition = runToPartition(runId);
        await h.index.ensureGroup(partition);
        await bornRun(h.store, runId);
        await h.store.prepare(unit(runId, "999"));

        const outcomes = await h
          .worker({
            checkPostgresCommit: async () => {
              throw new Error("ECONNRESET");
            },
          })
          .processPartition(partition, "w1");
        expect(outcomes).toEqual([{ kind: "retry", runId, reason: "pg-status-unavailable" }]);
        expect(h.quarantined).toHaveLength(0);
        // Left pending for a later retry.
        expect(await h.store.hasPreparedUnit(runId)).toBe(true);
      } finally {
        await h.store.quit();
      }
    }
  );

  containerTest(
    "XAUTOCLAIM reclaims an entry stranded by a dead consumer",
    async ({ redisOptions, prisma }) => {
      const h = harness(redisOptions, prisma);
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const runId = "run_rec_reclaim";
        const partition = runToPartition(runId);
        await h.index.ensureGroup(partition);
        await bornRun(h.store, runId);
        const xid = await committedXid(prisma);
        await h.store.prepare(unit(runId, xid));

        // "dead" consumer reads the entry into its PEL but never resolves/ACKs it.
        await raw.xreadgroup(
          "GROUP",
          RECOVERY_CONSUMER_GROUP,
          "dead",
          "COUNT",
          10,
          "STREAMS",
          pendingStreamKey(partition),
          ">"
        );

        // A live worker reclaims it (min idle 0) and finalizes.
        const outcomes = await h.worker().processPartition(partition, "live", { minIdleMs: 0 });
        expect(outcomes).toEqual([{ kind: "finalized", runId }]);
        expect((await h.store.getLatest(runId))?.id).toBe("s1");
        const pending = (await raw.xpending(
          pendingStreamKey(partition),
          RECOVERY_CONSUMER_GROUP
        )) as unknown[];
        expect(pending[0]).toBe(0);
      } finally {
        await raw.quit();
        await h.store.quit();
      }
    }
  );

  containerTest("halt does NOT stop the recovery loop", async ({ redisOptions, prisma }) => {
    const h = harness(redisOptions, prisma);
    try {
      const runId = "run_rec_halted";
      const partition = runToPartition(runId);
      await h.index.ensureGroup(partition);
      await bornRun(h.store, runId);
      const xid = await committedXid(prisma);
      await h.store.prepare(unit(runId, xid));

      const outcomes = await h.worker({ halted: () => true }).processPartition(partition, "w1");
      expect(outcomes).toEqual([{ kind: "finalized", runId }]);
      expect((await h.store.getLatest(runId))?.id).toBe("s1");
    } finally {
      await h.store.quit();
    }
  });

  // Item 7.4: an unmapped route is an AVAILABILITY failure, never an aged-out xid. Even a committed
  // mirrored unit must RETRY (typed unavailable surfaced), never abort, and stay pending.
  containerTest(
    "an unmapped route => RETRIES a committed mirrored unit (never aborts), stays pending",
    async ({ redisOptions, prisma }) => {
      const h = harness(redisOptions, prisma);
      try {
        const runId = "run_rec_unmapped_route";
        const partition = runToPartition(runId);
        await h.index.ensureGroup(partition);
        await bornRun(h.store, runId);
        const xid = await committedXid(prisma);
        await h.store.prepare(unit(runId, xid, { residency: "mirrored" }));

        const outcomes = await h
          .worker({
            checkPostgresCommit: async (_xid, route) => {
              throw new RouteUnavailableError(route);
            },
          })
          .processPartition(partition, "w1");
        expect(outcomes).toEqual([{ kind: "retry", runId, reason: "route-unavailable" }]);
        // Never aborted: the committed unit stays pending for a later retry, and no quarantine.
        expect(await h.store.hasPreparedUnit(runId)).toBe(true);
        expect((await h.store.getLatest(runId))?.id).toBe("s0");
        expect(h.quarantined).toHaveLength(0);
      } finally {
        await h.store.quit();
      }
    }
  );

  // Item 7.5: quarantine PERSISTS the original prepared payload to the durable key BEFORE the pending
  // entry is ACKed, and the reader returns it.
  containerTest(
    "quarantine persists the prepared payload durably before ACK; reader returns it",
    async ({ redisOptions, prisma }) => {
      const h = harness(redisOptions, prisma);
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const runId = "run_rec_quarantine_durable";
        const partition = runToPartition(runId);
        await h.index.ensureGroup(partition);
        await bornRun(h.store, runId);
        await h.store.prepare(unit(runId, "999", { residency: "redis-primary" }));

        const outcomes = await h
          .worker({
            checkPostgresCommit: async () => null,
            // The production quarantine: persist durably, then the caller records/logs.
            quarantine: async (u, reason) => {
              await h.store.quarantinePreparedUnit(u, reason);
              h.quarantined.push({ unit: u, reason });
            },
          })
          .processPartition(partition, "w1");
        expect(outcomes).toEqual([{ kind: "quarantined", runId, reason: "redis-primary-null" }]);

        // Recoverable: the reader returns the original payload, reason, and a timestamp.
        const record = await h.store.readQuarantinedUnit(runId);
        expect(record?.reason).toBe("redis-primary-null");
        expect(record?.unit.runId).toBe(runId);
        expect(record?.unit.residency).toBe("redis-primary");
        expect(record?.quarantinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(await h.store.listQuarantinedRunIds(partition)).toContain(runId);

        // Persisted BEFORE the ACK: the pending stream entry was ACKed (PEL empty) only after the
        // durable key exists.
        const pending = (await raw.xpending(
          pendingStreamKey(partition),
          RECOVERY_CONSUMER_GROUP
        )) as unknown[];
        expect(pending[0]).toBe(0);

        // The stream entry is also DELETED (not just ACKed): a quarantine leaves no stream entry behind,
        // so a run that keeps getting quarantined cannot grow the recovery stream without bound.
        expect(await raw.xlen(pendingStreamKey(partition))).toBe(0);
      } finally {
        await raw.quit();
        await h.store.quit();
      }
    }
  );

  // Item 7.3: single-run resolvePending finalizes a prepared-but-committed unit synchronously on demand,
  // reusing the SAME resolveEntry the sweep uses (no duplicate resolution path).
  containerTest(
    "resolvePending finalizes a single committed unit synchronously on demand",
    async ({ redisOptions, prisma }) => {
      const h = harness(redisOptions, prisma);
      try {
        const runId = "run_rec_resolve_pending";
        const partition = runToPartition(runId);
        await h.index.ensureGroup(partition);
        await bornRun(h.store, runId);
        const xid = await committedXid(prisma);
        await h.store.prepare(unit(runId, xid));

        const worker = h.worker();
        const resolvePending = async (id: string): Promise<void> => {
          const raw = await h.store.readPreparedUnitRaw(id);
          if (raw === undefined) return;
          const u = JSON.parse(raw) as PreparedPgUnit;
          await worker.resolveEntry({
            id: "resolve-pending",
            fields: { runId: id, transitionToken: u.transitionToken },
          });
        };

        await resolvePending(runId);
        expect((await h.store.getLatest(runId))?.id).toBe("s1");
        expect(await h.store.hasPreparedUnit(runId)).toBe(false);
      } finally {
        await h.store.quit();
      }
    }
  );
});

// Item 7.2: the sweeper ensures groups once and never overlaps a tick, on real infra.
describe("RecoverySweeper", () => {
  containerTest(
    "ensures groups once, resolves across partitions, and never overlaps a tick",
    async ({ redisOptions, prisma }) => {
      const h = harness(redisOptions, prisma);
      try {
        const runId = "run_sweeper_committed";
        const partition = runToPartition(runId);
        // The group must exist before the prepare XADDs, or a ">" read never delivers the entry.
        await h.index.ensureGroup(partition);
        await bornRun(h.store, runId);
        const xid = await committedXid(prisma);
        await h.store.prepare(unit(runId, xid));

        let ensureAllGroupsCalls = 0;
        const countingIndex = {
          ensureAllGroups: async () => {
            ensureAllGroupsCalls++;
            await h.index.ensureAllGroups();
          },
          summary: (p: number) => h.index.summary(p),
        };
        const sweeper = new RecoverySweeper({
          worker: h.worker(),
          pendingIndex: countingIndex,
          consumer: "sweeper-1",
        });

        // No-overlap: the running-guard is set synchronously before the first await, so a second tick
        // started while the first is in flight returns skipped.
        const first = sweeper.tick();
        const second = await sweeper.tick();
        expect(second.skipped).toBe(true);
        const firstResult = await first;
        expect(firstResult.skipped).toBe(false);
        expect(firstResult.outcomes).toContainEqual({ kind: "finalized", runId });

        // Init-once: a second (non-overlapping) tick does not re-ensure the groups.
        await sweeper.tick();
        expect(ensureAllGroupsCalls).toBe(1);
        expect((await h.store.getLatest(runId))?.id).toBe("s1");
      } finally {
        await h.store.quit();
      }
    }
  );
});

// Item 7.7: the no-eviction readiness probe reads maxmemory-policy off a real Redis.
describe("no-eviction readiness probe", () => {
  containerTest("reports the configured maxmemory-policy", async ({ redisOptions, prisma }) => {
    const h = harness(redisOptions, prisma);
    const raw = createRedisClient(redisOptions, { onError: () => {} });
    try {
      // Default testcontainer redis is noeviction => ready.
      expect(await h.store.readMaxMemoryPolicy()).toBe("noeviction");

      // Flip it to an evicting policy => not noeviction, so redis-primary must read as not-ready.
      await raw.config("SET", "maxmemory-policy", "allkeys-lru");
      expect(await h.store.readMaxMemoryPolicy()).toBe("allkeys-lru");
    } finally {
      await raw.config("SET", "maxmemory-policy", "noeviction");
      await raw.quit();
      await h.store.quit();
    }
  });
});
