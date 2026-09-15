// P2: a delayed non-birth finalize must NOT rebuild a partial history after the base keyspace expired.
// Real Redis (prepare/finalize + real key expiry) and real Postgres (committed xids for recovery). No
// mocks. Base expiry is forced deterministically with PEXPIRE, which reproduces the terminal-TTL expiry
// the guard defends against (the guard only reads key EXISTS + the stored state version).
import { describe, expect } from "vitest";
import { containerTest, redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import {
  RedisSnapshotStore,
  type PreparedEntry,
  type PreparedPgUnit,
  type SnapshotEntryInput,
} from "./redisSnapshotStore.js";
import { PendingIndex } from "./pendingIndex.js";
import {
  PendingRecoveryWorker,
  type PostgresCommitStatus,
  type QuarantineReason,
  type RecoveryDeps,
} from "./pendingRecoveryWorker.js";
import {
  preparedUnitKey,
  pendingStreamKeyForRun,
  runToPartition,
  snapshotKeys,
} from "./snapshotKeys.js";

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
function unit(runId: string, xid: string, over: Partial<PreparedPgUnit> = {}): PreparedPgUnit {
  return {
    protocolVersion: 1,
    transitionToken: "tok_late",
    postgresXid: xid,
    runId,
    organizationId: "org_1",
    residency: "mirrored",
    logicalRunStoreRoute: "logical:1",
    entries: [staged(runId, "s2", { expectedCur: "s1" })],
    ...over,
  };
}
async function committedXid(prisma: PrismaClient): Promise<string> {
  const rows = (await prisma.$queryRawUnsafe(`SELECT pg_current_xact_id()::text AS xid`)) as Array<{
    xid: string;
  }>;
  return rows[0].xid;
}
// Build a live base keyspace: birth + one transition (head = s1), with the given birth residency.
async function born(
  store: RedisSnapshotStore,
  runId: string,
  residency: "mirrored" | "redis-primary"
): Promise<void> {
  await store.append({
    entry: entry({ id: "s0", runId }),
    kind: "birth",
    isTerminal: false,
    residency,
  });
  await store.append({
    entry: entry({ id: "s1", runId }),
    kind: "transition",
    isTerminal: false,
    expectedCur: "s0",
  });
}
// Expire every base state key deterministically (as the terminal TTL would), leaving prep + pending.
async function expireBase(raw: any, runId: string): Promise<void> {
  const k = snapshotKeys(runId);
  await Promise.all([
    raw.pexpire(k.e, 1),
    raw.pexpire(k.idx, 1),
    raw.pexpire(k.cur, 1),
    raw.pexpire(k.seq, 1),
  ]);
  await new Promise((r) => setTimeout(r, 40));
}

describe("finalize base guard (P2)", () => {
  redisTest(
    "a non-birth finalize after base expiry returns baseMissing, recreates nothing, preserves prep+pending",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 300 });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      const runId = "run_p2_expire";
      const k = snapshotKeys(runId);

      await store.append({
        entry: entry({ id: "s0", runId }),
        kind: "birth",
        isTerminal: false,
        residency: "mirrored",
      });
      await store.append({
        entry: entry({ id: "s1", runId }),
        kind: "transition",
        isTerminal: false,
        expectedCur: "s0",
      });
      // Prepare a non-birth unit while the base is still alive; it never expires.
      expect((await store.prepare(unit(runId, "1"))).outcome).toBe("prepared");
      // Now expire every base state key (as the terminal TTL would).
      await Promise.all([
        raw.pexpire(k.e, 1),
        raw.pexpire(k.idx, 1),
        raw.pexpire(k.cur, 1),
        raw.pexpire(k.seq, 1),
      ]);
      await new Promise((r) => setTimeout(r, 40));
      expect(await raw.exists(k.e)).toBe(0);

      const res = await store.finalize(runId, "tok_late");
      expect(res.outcome).toBe("baseMissing");
      // No state recreated.
      for (const key of [k.e, k.idx, k.cur, k.seq]) expect(await raw.exists(key)).toBe(0);
      // Prep + pending preserved for recovery to decide.
      expect(await raw.exists(preparedUnitKey(runId))).toBe(1);
      expect(await raw.xlen(pendingStreamKeyForRun(runId))).toBeGreaterThan(0);
      await raw.quit();
    }
  );

  redisTest("a genuine birth still finalizes into an empty keyspace", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 300 });
    const raw = createRedisClient(redisOptions, { onError: () => {} });
    const runId = "run_p2_birth";
    const k = snapshotKeys(runId);
    const born = unit(runId, "1", {
      transitionToken: "tok_birth",
      entries: [staged(runId, "s0", { kind: "birth", expectedCur: "" })],
    });
    expect((await store.prepare(born)).outcome).toBe("prepared");
    const res = await store.finalize(runId, "tok_birth");
    expect(res.outcome).toBe("finalized");
    expect(await raw.exists(k.e)).toBe(1);
    expect(await raw.exists(k.seq)).toBe(1);
    await raw.quit();
  });

  containerTest(
    "recovery: mirrored discards through Postgres; redis-primary quarantines fail-closed",
    async ({ redisOptions, prisma }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 300 });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(createRedisClient(redisOptions, { onError: () => {} }));
      const quarantined: Array<{ unit: PreparedPgUnit; reason: QuarantineReason }> = [];
      const realCheck = async (xid8: string): Promise<PostgresCommitStatus> => {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT pg_xact_status($1::xid8) AS status`,
          xid8
        )) as Array<{
          status: string | null;
        }>;
        return rows[0].status as PostgresCommitStatus;
      };
      const deps: RecoveryDeps = {
        store,
        pendingIndex: index,
        checkPostgresCommit: realCheck,
        commitProbeExists: async () => true,
        quarantine: async (u, reason) => {
          quarantined.push({ unit: u, reason });
        },
      };
      const worker = new PendingRecoveryWorker(deps);

      // Mirrored: committed PG + expired base => discard the prepared Redis unit, ack, PG authoritative.
      const mRun = "run_p2_mirrored";
      const mPart = runToPartition(mRun);
      await index.ensureGroup(mPart);
      await born(store, mRun, "mirrored");
      expect((await store.prepare(unit(mRun, await committedXid(prisma)))).outcome).toBe(
        "prepared"
      );
      await expireBase(raw, mRun);
      const mOut = await worker.processPartition(mPart, "w");
      expect(mOut).toEqual([{ kind: "discarded", runId: mRun, reason: "postgres-authoritative" }]);
      expect(await raw.exists(preparedUnitKey(mRun))).toBe(0);
      expect(await raw.exists(snapshotKeys(mRun).e)).toBe(0);

      // Redis-primary: expired base => quarantine, fail closed, recreate nothing.
      const rRun = "run_p2_redisprimary";
      const rPart = runToPartition(rRun);
      const rk = snapshotKeys(rRun);
      await index.ensureGroup(rPart);
      await born(store, rRun, "redis-primary");
      expect(
        (
          await store.prepare(
            unit(rRun, await committedXid(prisma), { residency: "redis-primary" })
          )
        ).outcome
      ).toBe("prepared");
      await expireBase(raw, rRun);
      const rOut = await worker.processPartition(rPart, "w");
      expect(rOut).toEqual([{ kind: "quarantined", runId: rRun, reason: "base-expired" }]);
      expect(quarantined.map((q) => q.reason)).toContain("base-expired");
      expect(await raw.exists(rk.e)).toBe(0);
      await raw.quit();
    }
  );
});
