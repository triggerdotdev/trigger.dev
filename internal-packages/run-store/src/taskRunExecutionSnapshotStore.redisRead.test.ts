// Milestone M7: at the redis-read dial a MIRRORED run's reads are served pending-safe from MemoryDB,
// with Postgres fallback on a genuine miss and fail-closed on a MemoryDB error. Proven end-to-end
// against REAL Postgres + REAL Redis (testcontainers, no mocks): `resolvePending` is wired to the
// real PendingRecoveryWorker + real pg_xact_status on the same test primary.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore, type PreparedPgUnit } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  SnapshotReadUnavailableError,
} from "./taskRunExecutionSnapshotStore.js";
import { PendingIndex } from "./pendingIndex.js";
import {
  PendingRecoveryWorker,
  type PostgresCommitStatus,
  type QuarantineReason,
  type RecoveryDeps,
} from "./pendingRecoveryWorker.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";

function realCheck(prisma: PrismaClient) {
  return async (xid8: string): Promise<PostgresCommitStatus> => {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT pg_xact_status($1::xid8) AS status`,
      xid8
    )) as Array<{ status: string | null }>;
    return rows[0].status as PostgresCommitStatus;
  };
}

function realProbe(prisma: PrismaClient) {
  return async (snapshotId: string): Promise<boolean> => {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM "TaskRunExecutionSnapshot" WHERE id = $1`,
      snapshotId
    )) as unknown[];
    return rows.length > 0;
  };
}

function recoveryDeps(
  store: RedisSnapshotStore,
  index: PendingIndex,
  prisma: PrismaClient
): RecoveryDeps {
  const quarantined: Array<{ unit: PreparedPgUnit; reason: QuarantineReason }> = [];
  return {
    store,
    pendingIndex: index,
    checkPostgresCommit: realCheck(prisma),
    commitProbeExists: realProbe(prisma),
    quarantine: async (unit, reason) => {
      quarantined.push({ unit, reason });
    },
  };
}

// resolvePending wired to the REAL recovery path: read the live prepared unit for its token, then let
// the real worker resolve it against the real pg_xact_status on the same primary (finalize / abort /
// leave-pending). This is exactly what the recovery-worker role does per pending entry.
function makeResolvePending(store: RedisSnapshotStore, worker: PendingRecoveryWorker) {
  return async (runId: string): Promise<void> => {
    const raw = await store.readPreparedUnitRaw(runId);
    if (raw === undefined) return;
    const unit = JSON.parse(raw) as PreparedPgUnit;
    await worker.resolveEntry({
      id: "0-0",
      fields: { runId, transitionToken: unit.transitionToken },
    });
  };
}

function birthSnapshot(env: Awaited<ReturnType<typeof seedSnapshotEnvironment>>, id: string) {
  return {
    id,
    createdAt: new Date(),
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "Run was created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

// A snapshot row written to Postgres ONLY (not MemoryDB), later than any mirrored head. Used to make
// the Postgres "latest" diverge from the MemoryDB committed head, so a read that came from MemoryDB is
// distinguishable from one that came from Postgres.
async function insertPostgresOnlySnapshot(
  prisma: PrismaClient,
  env: Awaited<ReturnType<typeof seedSnapshotEnvironment>>,
  runId: string,
  id: string,
  createdAt: Date
) {
  await prisma.taskRunExecutionSnapshot.create({
    data: {
      id,
      runId,
      engine: "V2",
      executionStatus: "EXECUTING",
      description: "Postgres-only newer head",
      runStatus: "EXECUTING",
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
      createdAt,
    },
  });
}

describe("TaskRunExecutionSnapshotStore (redis-read) mirrored reads", () => {
  containerTest(
    "a finalized head reads from MemoryDB, not Postgres (heads differ)",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // Postgres now carries a NEWER head than MemoryDB (which still has the birth).
        const pgOnlyId = generateInternalId();
        await insertPostgresOnlySnapshot(
          prisma,
          env,
          runId,
          pgOnlyId,
          new Date(Date.now() + 5_000)
        );
        expect((await store.getLatest(runId))?.id).toBe(birthId);

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-read",
          logicalRunStoreRoute: ROUTE,
        });
        const head = await reader.findLatestExecutionSnapshot(runId);
        // The MemoryDB committed head, never the newer Postgres row.
        expect(head?.id).toBe(birthId);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "dual-write reads still come from Postgres (unchanged)",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        const pgOnlyId = generateInternalId();
        await insertPostgresOnlySnapshot(
          prisma,
          env,
          runId,
          pgOnlyId,
          new Date(Date.now() + 5_000)
        );

        // At dual-write the head is read straight from Postgres: the newer Postgres row wins.
        const head = await writer.findLatestExecutionSnapshot(runId);
        expect(head?.id).toBe(pgOnlyId);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a pending unit is resolved before returning: the RESOLVED head, never the stale pre-pending head",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const indexRaw = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(indexRaw);

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // A transition that CRASHES after the Postgres commit but before finalize: Postgres holds the
        // new row, MemoryDB is still pending on the birth head.
        const crashed = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
          hooks: {
            beforeFinalize: () => {
              throw new Error("__crash_before_finalize__");
            },
          },
        });
        await expect(
          crashed.createExecutionSnapshot({
            id: transitionId,
            createdAt: new Date(),
            run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
            snapshot: { executionStatus: "EXECUTING", description: "Run started" },
            previousSnapshotId: birthId,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          })
        ).rejects.toThrow(/__crash_before_finalize__/);
        expect(await store.hasPreparedUnit(runId)).toBe(true);
        expect((await store.getLatest(runId))?.id).toBe(birthId);

        const worker = new PendingRecoveryWorker(recoveryDeps(store, index, prisma));
        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-read",
          logicalRunStoreRoute: ROUTE,
          resolvePending: makeResolvePending(store, worker),
        });

        const head = await reader.findLatestExecutionSnapshot(runId);
        // pg_xact_status said committed => the pending unit finalized => the head advanced.
        expect(head?.id).toBe(transitionId);
        expect(await store.hasPreparedUnit(runId)).toBe(false);
      } finally {
        await indexRaw.quit();
        await store.quit();
      }
    }
  );

  containerTest(
    "a pending unit whose transaction is still in progress throws a retriable error, never a stale head",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const indexRaw = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(indexRaw);

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        const worker = new PendingRecoveryWorker(recoveryDeps(store, index, prisma));
        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-read",
          logicalRunStoreRoute: ROUTE,
          resolvePending: makeResolvePending(store, worker),
        });

        // Hold a real transaction open so its xid8 is genuinely IN PROGRESS while we read. The
        // pg_xact_status query runs on a different pooled connection and sees it uncommitted.
        let releaseXid: (xid: string) => void = () => {};
        const xidReady = new Promise<string>((r) => (releaseXid = r));
        let finishTx: () => void = () => {};
        const holdTx = new Promise<void>((r) => (finishTx = r));

        const txRun = prisma.$transaction(
          async (tx) => {
            const rows = (await tx.$queryRawUnsafe(
              `SELECT pg_current_xact_id()::text AS xid`
            )) as Array<{ xid: string }>;
            releaseXid(rows[0].xid);
            await holdTx;
          },
          { timeout: 20_000 }
        );

        try {
          const xid = await xidReady;
          const unit: PreparedPgUnit = {
            protocolVersion: 1,
            transitionToken: generateInternalId(),
            postgresXid: xid,
            runId,
            organizationId: env.organizationId,
            residency: "mirrored",
            logicalRunStoreRoute: ROUTE,
            entries: [
              {
                entry: {
                  id: transitionId,
                  runId,
                  engine: "V2",
                  executionStatus: "EXECUTING",
                  description: "Run started",
                  runStatus: "EXECUTING",
                  createdAt: new Date().toISOString(),
                  previousSnapshotId: birthId,
                  environmentId: env.id,
                  environmentType: env.type,
                  projectId: env.projectId,
                  organizationId: env.organizationId,
                },
                kind: "transition",
                isTerminal: false,
                expectedCur: birthId,
              },
            ],
            commitProbeSnapshotId: transitionId,
          };
          expect((await store.prepare(unit)).outcome).toBe("prepared");

          // In progress => recovery leaves it pending => the read must fail closed, not serve the birth.
          await expect(reader.findLatestExecutionSnapshot(runId)).rejects.toBeInstanceOf(
            SnapshotReadUnavailableError
          );
          expect(await store.hasPreparedUnit(runId)).toBe(true);
        } finally {
          finishTx();
          await txRun.catch(() => undefined);
        }
      } finally {
        await indexRaw.quit();
        await store.quit();
      }
    }
  );

  containerTest(
    "a genuine MemoryDB miss for a mirrored run falls back to Postgres",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const snapshotId = generateInternalId();

        // A run that exists in Postgres only (no MemoryDB keyspace at all).
        await delegate.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, snapshotId),
        });
        expect(await store.getLatest(runId)).toBeNull();

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-read",
          logicalRunStoreRoute: ROUTE,
        });
        const head = await reader.findLatestExecutionSnapshot(runId);
        expect(head?.id).toBe(snapshotId);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a MemoryDB read error fails closed (retriable) and does NOT fall back to Postgres",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const writeStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      // A store whose connection is closed: every read rejects, which is an ERROR, never a miss.
      const brokenStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      await brokenStore.quit();

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store: writeStore,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store: brokenStore,
          mode: "redis-read",
          logicalRunStoreRoute: ROUTE,
        });
        // Postgres HAS the head, so a wrongful fallback would return it. Fail-closed must not.
        await expect(reader.findLatestExecutionSnapshot(runId)).rejects.toBeInstanceOf(
          SnapshotReadUnavailableError
        );
      } finally {
        await writeStore.quit();
      }
    }
  );
});
