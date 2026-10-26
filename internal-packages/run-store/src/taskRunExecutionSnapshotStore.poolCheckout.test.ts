// The owning transaction holds one pooled Postgres connection, so any Postgres read the decorator does
// while it is open must not need a second connection from the same pool. Each case runs the decorator
// over a ONE-connection pool, where a nested checkout is a deterministic pool timeout instead of a
// load-dependent deadlock. REAL Postgres + REAL Redis, no mocks.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { PrismaClient, type PrismaClientOrTransaction } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { Registry } from "prom-client";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";
import { PendingIndex } from "./pendingIndex.js";
import { PendingRecoveryWorker, type PostgresCommitStatus } from "./pendingRecoveryWorker.js";
import { preparedUnitKey, runToPartition, snapshotKeys } from "./snapshotKeys.js";
import { toWireRoute } from "./snapshotResidency.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";
import { decoratorMetrics, metricValue } from "./testFixtures/promMetrics.js";
import { callsBetween, commandCalls } from "./testFixtures/redisCommandStats.js";

const ROUTE = "logical:1";

function onePooledConnection(uri: string): PrismaClient {
  const url = new URL(uri);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "2");
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

type Env = Awaited<ReturnType<typeof seedSnapshotEnvironment>>;

function birthSnapshot(env: Env, id: string) {
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

function transition(env: Env, runId: string, id: string, previousSnapshotId: string) {
  return {
    id,
    createdAt: new Date(),
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING" as const, description: "Run started" },
    previousSnapshotId,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

// Births a run, then leaves its next unit committed in Postgres but never finalized, so the following
// write's prepare finds that unit busy. Returns a resolver wired as the webapp wires it: pg_xact_status
// and the commit probe on the SAME pooled client the owning transaction draws from.
async function seedRunWithPendingUnit(
  prisma: PrismaClient,
  limited: PrismaClient,
  delegate: PostgresRunStore,
  store: RedisSnapshotStore,
  index: PendingIndex
) {
  const env = await seedSnapshotEnvironment(prisma);
  const runId = generateInternalId();
  const birthId = generateInternalId();
  const crashedId = generateInternalId();
  await index.ensureGroup(runToPartition(runId));

  const born = new TaskRunExecutionSnapshotStore(delegate, {
    store,
    mode: "dual-write",
    logicalRunStoreRoute: ROUTE,
  });
  await born.createRun({
    data: buildCreateRunData(runId, env),
    snapshot: birthSnapshot(env, birthId),
  });

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
    crashed.createExecutionSnapshot(transition(env, runId, crashedId, birthId))
  ).rejects.toThrow(/__crash_before_finalize__/);
  expect(await store.hasPreparedUnit(runId)).toBe(true);

  const { resolvePending } = recoveryResolver(limited, store, index);
  return { env, runId, crashedId, resolvePending };
}

// The recovery resolver wired as the webapp wires it: pg_xact_status and the commit probe on the given
// pooled client, and the resolver's outcome discarded.
function recoveryResolver(client: PrismaClient, store: RedisSnapshotStore, index: PendingIndex) {
  const worker = new PendingRecoveryWorker({
    store,
    pendingIndex: index,
    checkPostgresCommit: async (xid) => {
      const rows = await client.$queryRawUnsafe<Array<{ status: PostgresCommitStatus }>>(
        "SELECT pg_xact_status($1::xid8) AS status",
        xid
      );
      return rows[0]?.status ?? null;
    },
    commitProbeExists: async (snapshotId) => {
      const rows = await client.$queryRawUnsafe<unknown[]>(
        'SELECT 1 FROM "TaskRunExecutionSnapshot" WHERE id = $1',
        snapshotId
      );
      return rows.length > 0;
    },
    quarantine: async (unit, reason) => {
      await store.quarantinePreparedUnit(unit, reason);
    },
  });
  const resolvePending = async (id: string, options?: { requireSettledTransaction?: boolean }) => {
    await worker.resolveEntry({ id: "", fields: { runId: id } }, options);
  };
  return { resolvePending };
}

describe("TaskRunExecutionSnapshotStore never checks out a second pooled connection", () => {
  containerTest(
    "a busy prepare recovers the earlier committed unit and retries on a one-connection pool",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const limited = onePooledConnection(postgresContainer.getConnectionUri());
      const delegate = new PostgresRunStore({ prisma: limited, readOnlyPrisma: limited });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const indexRaw = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(indexRaw);
      try {
        const { env, runId, crashedId, resolvePending } = await seedRunWithPendingUnit(
          prisma,
          limited,
          delegate,
          store,
          index
        );
        const next = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
          resolvePending,
        });

        const nextId = generateInternalId();
        await next.createExecutionSnapshot(transition(env, runId, nextId, crashedId));

        expect(await store.hasPreparedUnit(runId)).toBe(false);
        expect((await store.getById(runId, crashedId))?.id).toBe(crashedId);
        expect((await store.getLatest(runId))?.id).toBe(nextId);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(3);
      } finally {
        await indexRaw.quit();
        await store.quit();
        await limited.$disconnect();
      }
    }
  );

  containerTest(
    "a busy prepare never replays an engine callback: it resolves the earlier unit and fails retriably",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const limited = onePooledConnection(postgresContainer.getConnectionUri());
      const delegate = new PostgresRunStore({ prisma: limited, readOnlyPrisma: limited });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const indexRaw = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(indexRaw);
      try {
        const { env, runId, crashedId, resolvePending } = await seedRunWithPendingUnit(
          prisma,
          limited,
          delegate,
          store,
          index
        );
        const writes: string[] = [];
        const next = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
          resolvePending,
          metrics: {
            recordWrite: (outcome) => writes.push(outcome),
            recordReadSource: () => {},
          },
        });

        // As the engine does, the snapshot route is read before the transaction opens, so the write
        // inside it resolves residency without a Postgres read.
        const route = await next.readSnapshotRoute(runId, env.organizationId);
        if (!route) throw new Error("expected a snapshot route for an existing run");
        const snapshotRoute = toWireRoute(route);
        // The counter stands in for the engine's Redis queue publish (or worker ack) inside the
        // callback: a rollback does not undo it, so every invocation is one real side effect.
        let sideEffects = 0;
        const engineCallback =
          (snapshotId: string) => async (txStore: RunStore, tx: PrismaClientOrTransaction) => {
            sideEffects++;
            await txStore.createExecutionSnapshot(
              { ...transition(env, runId, snapshotId, crashedId), snapshotRoute },
              tx
            );
            return snapshotId;
          };

        const first = await next.runInTransaction(runId, engineCallback(generateInternalId())).then(
          () => undefined,
          (error: unknown) => error
        );
        // Exactly one side effect: the callback was not replayed after the busy prepare.
        expect(sideEffects).toBe(1);
        expect(first).toBeInstanceOf(Error);
        expect((first as Error).message).toBe("snapshot prepare rejected: busy");
        expect(writes).toEqual(["failed"]);
        // The earlier unit was resolved before the rejection, and nothing of this attempt is prepared.
        expect(await store.hasPreparedUnit(runId)).toBe(false);
        expect((await store.getLatest(runId))?.id).toBe(crashedId);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(2);

        // The caller's retry runs the callback once more and commits.
        const retryId = generateInternalId();
        await expect(next.runInTransaction(runId, engineCallback(retryId))).resolves.toBe(retryId);
        expect(sideEffects).toBe(2);
        expect(writes).toEqual(["failed", "written"]);
        expect(await store.hasPreparedUnit(runId)).toBe(false);
        expect((await store.getLatest(runId))?.id).toBe(retryId);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(3);
      } finally {
        await indexRaw.quit();
        await store.quit();
        await limited.$disconnect();
      }
    }
  );

  containerTest(
    "settlePendingUnit with nothing pending makes one Redis read and starts no recovery",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const limited = onePooledConnection(postgresContainer.getConnectionUri());
      const delegate = new PostgresRunStore({ prisma: limited, readOnlyPrisma: limited });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const indexRaw = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(indexRaw);
      const closed = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const { resolvePending } = recoveryResolver(limited, store, index);
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
          resolvePending,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, generateInternalId()),
        });
        expect(await store.hasPreparedUnit(runId)).toBe(false);

        // One EXISTS on the prepared-unit key, and no HGET: the resolver's first read never ran, so
        // neither did its Postgres reads.
        const before = await commandCalls(indexRaw);
        await writer.settlePendingUnit(runId);
        const after = await commandCalls(indexRaw);
        expect(callsBetween(before, after, "exists")).toBe(1);
        expect(callsBetween(before, after, "hget")).toBe(0);

        // A Redis error is not swallowed: the caller's job retries rather than meeting busy.
        await closed.quit();
        const unreachable = new TaskRunExecutionSnapshotStore(delegate, {
          store: new RedisSnapshotStore({ client: closed, completedTtlMs: 60_000 }),
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
          resolvePending,
        });
        await expect(unreachable.settlePendingUnit(runId)).rejects.toThrow(/Connection is closed/);

        // Without a recovery resolver there is nothing to settle with, so nothing is read.
        const unwired = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
        });
        const beforeUnwired = await commandCalls(indexRaw);
        await unwired.settlePendingUnit(runId);
        expect(callsBetween(beforeUnwired, await commandCalls(indexRaw), "exists")).toBe(0);
      } finally {
        await indexRaw.quit();
        await store.quit();
        await limited.$disconnect();
      }
    }
  );

  containerTest(
    "settlePendingUnit resolves an earlier committed unit before any transaction opens",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const limited = onePooledConnection(postgresContainer.getConnectionUri());
      const delegate = new PostgresRunStore({ prisma: limited, readOnlyPrisma: limited });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const indexRaw = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(indexRaw);
      try {
        const { env, runId, crashedId, resolvePending } = await seedRunWithPendingUnit(
          prisma,
          limited,
          delegate,
          store,
          index
        );
        const register = new Registry();
        const next = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
          resolvePending,
          metrics: decoratorMetrics(register),
        });

        await next.settlePendingUnit(runId);
        expect(await store.hasPreparedUnit(runId)).toBe(false);
        expect((await store.getLatest(runId))?.id).toBe(crashedId);

        // The next write's prepare is no longer busy.
        const nextId = generateInternalId();
        await next.createExecutionSnapshot(transition(env, runId, nextId, crashedId));
        expect(
          await metricValue(register, "snapshot_store_writes_total", { outcome: "written" })
        ).toBe(1);
        expect(
          await metricValue(register, "snapshot_store_writes_total", { outcome: "failed" })
        ).toBeUndefined();
        expect((await store.getLatest(runId))?.id).toBe(nextId);

        // The settle only resolves a unit whose transaction is proven settled: an unreadable unit is
        // left pending for the sweep to quarantine, and the settle fails busy.
        await indexRaw.hset(preparedUnitKey(runId), "unit", "{not json");
        await expect(next.settlePendingUnit(runId)).rejects.toThrow(
          /^snapshot prepare rejected: busy$/
        );
        expect(await store.readPendingState(runId)).toEqual({ prepared: true, quarantined: false });
        expect((await store.getLatest(runId))?.id).toBe(nextId);
      } finally {
        await indexRaw.quit();
        await store.quit();
        await limited.$disconnect();
      }
    }
  );

  containerTest(
    "settlePendingUnit rejects busy before any transaction while the earlier unit's transaction is open",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const limited = onePooledConnection(postgresContainer.getConnectionUri());
      const delegate = new PostgresRunStore({ prisma: limited, readOnlyPrisma: limited });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const indexRaw = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(indexRaw);
      const register = new Registry();
      let releaseHeld!: () => void;
      const held = new Promise<void>((resolve) => (releaseHeld = resolve));
      let holding: Promise<unknown> | undefined;
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const heldId = generateInternalId();
        await index.ensureGroup(runToPartition(runId));
        await new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
        }).createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // A writer on a second Prisma client prepares its unit inside an interactive transaction that
        // stays open, then crashes before finalize once it commits: the unit is pending throughout.
        let markPrepared!: () => void;
        const prepared = new Promise<void>((resolve) => (markPrepared = resolve));
        const holder = new TaskRunExecutionSnapshotStore(
          new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          {
            store,
            mode: "dual-write",
            logicalRunStoreRoute: ROUTE,
            hooks: {
              afterPrepare: async () => {
                markPrepared();
                await held;
              },
              beforeFinalize: () => {
                throw new Error("__crash_before_finalize__");
              },
            },
          }
        );
        holding = holder.createExecutionSnapshot(transition(env, runId, heldId, birthId)).then(
          () => undefined,
          (error: unknown) => error
        );
        await prepared;

        // Precondition: the unit carries the open transaction's xid, which Postgres reports in progress.
        const raw = await store.readPreparedUnitRaw(runId);
        if (raw === undefined) throw new Error("expected a prepared unit");
        const unit = JSON.parse(raw) as { postgresXid: string; transitionToken: string };
        const xactStatus = async () =>
          (
            await prisma.$queryRawUnsafe<Array<{ status: string | null }>>(
              "SELECT pg_xact_status($1::xid8) AS status",
              unit.postgresXid
            )
          )[0]?.status;
        expect(await xactStatus()).toBe("in progress");

        const { resolvePending } = recoveryResolver(limited, store, index);
        const settler = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
          resolvePending,
          metrics: decoratorMetrics(register),
        });

        // The resolver cannot settle an in-progress transaction, so the settle fails before the
        // caller's transaction opens, as the busy prepare inside it would have.
        await expect(settler.settlePendingUnit(runId)).rejects.toThrow(
          /^snapshot prepare rejected: busy$/
        );
        expect(
          await metricValue(register, "snapshot_store_writes_total", { outcome: "failed" })
        ).toBe(1);
        // The earlier unit is untouched and nothing moved: no new snapshot row, the head unchanged.
        expect(await store.hasPreparedUnit(runId)).toBe(true);
        expect(await store.readPreparedUnitRaw(runId)).toBe(raw);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(1);
        expect((await store.getLatest(runId))?.id).toBe(birthId);

        // Once the held transaction commits, the next settle finalizes its unit.
        releaseHeld();
        const heldResult = await holding;
        expect((heldResult as Error).message).toBe("__crash_before_finalize__");
        expect(await xactStatus()).toBe("committed");
        expect(await store.hasPreparedUnit(runId)).toBe(true);

        await settler.settlePendingUnit(runId);
        expect(await store.hasPreparedUnit(runId)).toBe(false);
        expect((await store.getLatest(runId))?.id).toBe(heldId);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(2);
        expect(
          await metricValue(register, "snapshot_store_writes_total", { outcome: "failed" })
        ).toBe(1);
      } finally {
        releaseHeld();
        await holding;
        await indexRaw.quit();
        await store.quit();
        await limited.$disconnect();
      }
    }
  );

  containerTest(
    "a mirrored head repair reads the committed head without a second pooled connection",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const limited = onePooledConnection(postgresContainer.getConnectionUri());
      const delegate = new PostgresRunStore({ prisma: limited, readOnlyPrisma: limited });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => "dual-write",
          logicalRunStoreRoute: ROUTE,
          resolvePrimaryReadClient: () => delegate.primaryReadClient,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // The birth entry is in MemoryDB but its head pointer is unset: the next prepare fork-guards on
        // an empty head, which the repair re-points at the Postgres committed head.
        await raw.del(snapshotKeys(runId).cur);
        expect(await raw.get(snapshotKeys(runId).cur)).toBeNull();

        const nextId = generateInternalId();
        await writer.createExecutionSnapshot(transition(env, runId, nextId, birthId));

        expect((await store.getLatest(runId))?.id).toBe(nextId);
        expect(await store.hasPreparedUnit(runId)).toBe(false);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(2);
      } finally {
        await raw.quit();
        await store.quit();
        await limited.$disconnect();
      }
    }
  );
});
