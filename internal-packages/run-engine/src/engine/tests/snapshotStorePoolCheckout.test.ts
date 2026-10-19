// The snapshot store's owning transaction holds one pooled Postgres connection. A read issued on the
// SAME pool from inside that transaction needs a second connection, so with as many concurrent
// transactions as the pool has connections every one of them waits on the pool it holds and times out.
// These drive the real engine callers with a ONE-connection pool, which turns any such nested checkout
// into a deterministic pool timeout. Real Postgres + Redis, no mocks.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import {
  PendingIndex,
  PendingRecoveryWorker,
  PostgresRunStore,
  preparedUnitKey,
  RedisSnapshotStore,
  runToPartition,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
  type PostgresCommitStatus,
  type SnapshotStoreDial,
  type TaskRunExecutionSnapshotStoreOptions,
} from "@internal/run-store";
import { createRedisClient } from "@internal/redis";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import {
  PrismaClient,
  type TaskRunExecutionStatus,
  type TaskRunStatus,
} from "@trigger.dev/database";
import { randomUUID } from "node:crypto";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import { PostgresPendingVersionRunIdLookup } from "./postgresPendingVersionLookup.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const ROUTE = "logical:1";
const machines = {
  defaultMachine: "small-1x",
  machines: {
    "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
  },
  baseCostInCents: 0.0001,
};

// A second client on the same database whose pool has exactly one connection. A nested checkout from
// inside a transaction on it can never be satisfied, so it fails after `pool_timeout` seconds.
function onePooledConnection(uri: string): PrismaClient {
  const url = new URL(uri);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "2");
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

// Every command the Redis server ran while `fn` did, seen through MONITOR on its own connection. The
// monitor streams commands in execution order, so once a marker sent afterwards arrives, so has the rest.
async function commandsRunDuring(redisOptions: any, fn: () => Promise<void>): Promise<string[][]> {
  const client = createRedisClient(redisOptions, { onError: () => {} });
  const monitor = await client.monitor();
  const seen: string[][] = [];
  monitor.on("monitor", (_time: string, args: string[]) => seen.push(args));
  try {
    await fn();
    const marker = `monitor-marker-${randomUUID()}`;
    await client.echo(marker);
    for (let i = 0; i < 500 && !seen.some((args) => args.includes(marker)); i++) {
      await setTimeout(10);
    }
    expect(seen.some((args) => args.includes(marker))).toBe(true);
    return seen;
  } finally {
    monitor.disconnect();
    client.disconnect();
  }
}

// Waits until some Postgres backend is blocked on a lock, as the promotion's run update is behind
// another transaction's row lock.
async function waitForRowLockWait(prisma: PrismaClient): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const rows = await prisma.$queryRawUnsafe<Array<{ waiting: number }>>(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()"
    );
    if (rows[0].waiting > 0) return;
    await setTimeout(10);
  }
  throw new Error("no backend waited on a lock");
}

function makeEngine(
  prisma: PrismaClient,
  redisOptions: any,
  snapshotStore: RedisSnapshotStore,
  dial: () => SnapshotStoreDial | undefined,
  options?: Pick<TaskRunExecutionSnapshotStoreOptions, "resolvePending">
) {
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  // Wired as the webapp wires each leaf: the primary-read seam is the same pooled writer client.
  const store = new TaskRunExecutionSnapshotStore(delegate, {
    ...options,
    store: snapshotStore,
    mode: "dual-write",
    resolveDial: dial,
    residencyResolver: new SnapshotResidencyResolver({ store: snapshotStore }),
    resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
    resolvePrimaryReadClient: () => delegate.primaryReadClient,
    logicalRunStoreRoute: ROUTE,
  });
  return new RunEngine({
    prisma,
    store,
    worker: { redis: redisOptions, disabled: true },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines,
    pendingVersionRunIdLookup: new PostgresPendingVersionRunIdLookup(prisma),
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

// The recovery resolver wired as the webapp wires it: pg_xact_status and the commit probe on the
// writer, and the resolver's outcome discarded.
function recoveryResolver(
  prisma: PrismaClient,
  redisOptions: any,
  snapshotStore: RedisSnapshotStore
) {
  const indexRaw = createRedisClient(redisOptions, { onError: () => {} });
  const index = new PendingIndex(indexRaw);
  const recovery = new PendingRecoveryWorker({
    store: snapshotStore,
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
      await snapshotStore.quarantinePreparedUnit(unit, reason);
    },
  });
  return {
    index,
    resolvePending: async (id: string, options?: { requireSettledTransaction?: boolean }) => {
      await recovery.resolveEntry({ id: "", fields: { runId: id } }, options);
    },
    quit: () => indexRaw.quit(),
  };
}

// A mirrored run parked in PENDING_VERSION, a promoter wired with the recovery resolver, and a way to
// leave a later unit committed in Postgres but never finalized, so a prepare for the run finds it busy.
async function parkedMirroredRun(
  prisma: PrismaClient,
  redisOptions: any,
  friendlyId: string,
  taskIdentifier: string
) {
  const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
  const recovery = recoveryResolver(prisma, redisOptions, snapshotStore);
  const index = recovery.index;
  const setup = makeEngine(prisma, redisOptions, snapshotStore, () => "dual-write");
  const promoter = makeEngine(prisma, redisOptions, snapshotStore, () => "dual-write", {
    resolvePending: recovery.resolvePending,
  });
  const cleanup = async () => {
    await setup.quit();
    await promoter.quit();
    await recovery.quit();
    await snapshotStore.quit();
  };

  try {
    const run = await setup.trigger(
      {
        number: 1,
        friendlyId,
        environment: env,
        taskIdentifier,
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: `t-${friendlyId}`,
        spanId: `s-${friendlyId}`,
        workerQueue: "main",
        queue: `task/${taskIdentifier}`,
        isTest: false,
        tags: [],
      },
      prisma
    );
    await index.ensureGroup(runToPartition(run.id));

    // A worker without the task: dequeuing parks the run in PENDING_VERSION.
    await setupBackgroundWorker(setup, env, ["test-task-other"]);
    for (let i = 0; i < 10; i++) {
      await setup.runQueue.processMasterQueueForEnvironment(env.id, 5);
      await setup.dequeueFromWorkerQueue({ consumerId: friendlyId, workerQueue: "main" });
      const parked = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
      if (parked.status === "PENDING_VERSION") break;
      await setTimeout(200);
    }
    expect((await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } })).status).toBe(
      "PENDING_VERSION"
    );
    const parked = await setup.getRunExecutionData({ runId: run.id });
    assertNonNullable(parked);
    // Precondition: the run is mirrored, so its transitions go through the prepare protocol.
    expect((await snapshotStore.getLatest(run.id))?.id).toBe(parked.snapshot.id);

    const crashed = new TaskRunExecutionSnapshotStore(
      new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
      {
        store: snapshotStore,
        mode: "dual-write",
        resolveDial: () => "dual-write",
        logicalRunStoreRoute: ROUTE,
        hooks: {
          beforeFinalize: () => {
            throw new Error("__crash_before_finalize__");
          },
        },
      }
    );
    // Leaves a unit committed in Postgres but pending in MemoryDB, on top of the parked snapshot or of
    // `at`, and returns its snapshot id.
    const strandUnit = async (at?: {
      runStatus: TaskRunStatus;
      snapshot: { id: string; executionStatus: TaskRunExecutionStatus };
    }) => {
      const id = generateInternalId();
      const previous = at?.snapshot ?? parked.snapshot;
      await expect(
        crashed.createExecutionSnapshot({
          id,
          run: { id: run.id, status: at?.runStatus ?? "PENDING_VERSION" },
          snapshot: {
            executionStatus: previous.executionStatus,
            description: "Earlier unit left pending",
          },
          previousSnapshotId: previous.id,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        })
      ).rejects.toThrow(/__crash_before_finalize__/);
      expect(await snapshotStore.hasPreparedUnit(run.id)).toBe(true);
      return id;
    };

    return { env, run, parked, setup, promoter, snapshotStore, strandUnit, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

describe("snapshot store transactions never check out a second pooled connection", () => {
  containerTest(
    "continueRunIfUnblocked resumes a redis-primary run with completed waitpoints on a one-connection pool",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const limited = onePooledConnection(postgresContainer.getConnectionUri());
      // The run is born redis-primary and blocked on an ordinary pool; only the resume runs on the
      // one-connection pool, so the guard isolates the resume transaction.
      const setup = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-only");
      const resumer = makeEngine(limited, redisOptions, snapshotStore, () => "redis-only");

      try {
        await setupBackgroundWorker(setup, env, "test-task");
        const run = await setup.trigger(
          {
            number: 1,
            friendlyId: "run_poolwp",
            environment: env,
            taskIdentifier: "test-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-poolwp",
            spanId: "s-poolwp",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        let dequeued: Awaited<ReturnType<RunEngine["dequeueFromWorkerQueue"]>> = [];
        for (let i = 0; i < 25 && dequeued.length === 0; i++) {
          await setup.runQueue.processMasterQueueForEnvironment(env.id, 5);
          dequeued = await setup.dequeueFromWorkerQueue({
            consumerId: "pool_wp",
            workerQueue: "main",
          });
          if (dequeued.length === 0) await setTimeout(200);
        }
        expect(dequeued.length).toBe(1);
        await setup.startRunAttempt({ runId: run.id, snapshotId: dequeued[0].snapshot.id });

        const waitpoint = await setup.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });
        const blocked = await setup.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.waitpoint.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });
        expect(blocked.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
        // Precondition: the run really is redis-primary (no Postgres snapshot rows at all).
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(0);

        await setup.completeWaitpoint({ id: waitpoint.waitpoint.id });

        // The resume writes a redis-primary snapshot carrying the completed-waitpoint cycle. Its
        // records must be read before the owning transaction opens, not from inside it.
        const result = await resumer.waitpointSystem.continueRunIfUnblocked({ runId: run.id });
        expect(result.status).toBe("unblocked");

        const resumed = await setup.getRunExecutionData({ runId: run.id });
        assertNonNullable(resumed);
        expect(resumed.snapshot.executionStatus).toBe("EXECUTING");
        expect(resumed.completedWaitpoints.map((w) => w.id)).toEqual([waitpoint.waitpoint.id]);
      } finally {
        await setup.quit();
        await resumer.quit();
        await snapshotStore.quit();
        await limited.$disconnect();
      }
    }
  );

  containerTest(
    "pending-version promotion of a postgres-resident run completes on a one-connection pool",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const limited = onePooledConnection(postgresContainer.getConnectionUri());
      // Dial off: the snapshot store is constructed (as it is whenever MemoryDB is configured) but the
      // org is not enrolled, so every snapshot is postgres-resident.
      // Both engines are wired with the recovery resolver, as the webapp wires them, so a settle would
      // read MemoryDB.
      const recovery = recoveryResolver(prisma, redisOptions, snapshotStore);
      const wired = { resolvePending: recovery.resolvePending };
      const setup = makeEngine(prisma, redisOptions, snapshotStore, () => "off", wired);
      const promoter = makeEngine(limited, redisOptions, snapshotStore, () => "off", wired);

      try {
        const taskIdentifier = "test-task";
        const run = await setup.trigger(
          {
            number: 1,
            friendlyId: "run_poolpv",
            environment: env,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-poolpv",
            spanId: "s-poolpv",
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        // A worker without the task: dequeuing parks the run in PENDING_VERSION.
        await setupBackgroundWorker(setup, env, ["test-task-other"]);
        for (let i = 0; i < 10; i++) {
          await setup.runQueue.processMasterQueueForEnvironment(env.id, 5);
          await setup.dequeueFromWorkerQueue({ consumerId: "pool_pv", workerQueue: "main" });
          const parked = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
          if (parked.status === "PENDING_VERSION") break;
          await setTimeout(200);
        }
        expect((await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } })).status).toBe(
          "PENDING_VERSION"
        );

        // The worker that has the task. Its scheduled promotion job never runs (workers disabled);
        // the promotion is driven directly on the one-connection pool instead.
        const deployed = await setupBackgroundWorker(setup, env, taskIdentifier);
        const commands = await commandsRunDuring(redisOptions, async () => {
          await promoter.pendingVersionSystem.enqueueRunsForBackgroundWorker(deployed.worker.id);

          // Starting the attempt of a postgres-resident run does not settle either.
          let dequeued: Awaited<ReturnType<RunEngine["dequeueFromWorkerQueue"]>> = [];
          for (let i = 0; i < 25 && dequeued.length === 0; i++) {
            await setup.runQueue.processMasterQueueForEnvironment(env.id, 5);
            dequeued = await setup.dequeueFromWorkerQueue({
              consumerId: "pool_pv",
              workerQueue: "main",
            });
            if (dequeued.length === 0) await setTimeout(200);
          }
          expect(dequeued.length).toBe(1);
          await setup.startRunAttempt({ runId: run.id, snapshotId: dequeued[0].snapshot.id });
        });

        const started = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(started.status).toBe("EXECUTING");
        const data = await setup.getRunExecutionData({ runId: run.id });
        assertNonNullable(data);
        expect(data.snapshot.executionStatus).toBe("EXECUTING");
        // Still postgres-resident: the snapshot is a real Postgres row and MemoryDB holds nothing.
        expect(
          await prisma.taskRunExecutionSnapshot.count({ where: { id: data.snapshot.id } })
        ).toBe(1);
        expect(await snapshotStore.getLatest(run.id)).toBeNull();

        // A postgres-resident run never reaches the settle, so neither engine read its prepared-unit key.
        const prepKey = preparedUnitKey(run.id);
        expect(
          commands.filter(
            ([name, ...args]) => name.toLowerCase() === "exists" && args.includes(prepKey)
          )
        ).toEqual([]);
      } finally {
        await setup.quit();
        await promoter.quit();
        await recovery.quit();
        await snapshotStore.quit();
        await limited.$disconnect();
      }
    }
  );
  containerTest(
    "a pending-version promotion settles an earlier pending unit first and publishes the run once",
    async ({ prisma, redisOptions }) => {
      const taskIdentifier = "test-task";
      const h = await parkedMirroredRun(prisma, redisOptions, "run_poolsettle", taskIdentifier);
      try {
        await h.strandUnit();
        const deployed = await setupBackgroundWorker(h.setup, h.env, taskIdentifier);

        // The earlier unit is resolved before the promotion's transaction opens, so the first
        // attempt commits instead of failing busy after it has published.
        await h.promoter.pendingVersionSystem.enqueueRunsForBackgroundWorker(deployed.worker.id);
        expect(await h.promoter.runQueue.messageExists(h.env.organization.id, h.run.id)).toBe(1);
        expect(await h.promoter.runQueue.lengthOfQueue(h.env, `task/${taskIdentifier}`)).toBe(1);
        expect((await prisma.taskRun.findFirstOrThrow({ where: { id: h.run.id } })).status).toBe(
          "PENDING"
        );
        const data = await h.setup.getRunExecutionData({ runId: h.run.id });
        assertNonNullable(data);
        expect(data.snapshot.executionStatus).toBe("QUEUED");
        expect((await h.snapshotStore.getLatest(h.run.id))?.id).toBe(data.snapshot.id);
        expect(await h.snapshotStore.hasPreparedUnit(h.run.id)).toBe(false);

        // Starting the attempt settles too, before its own transaction: a unit stranded after the
        // dequeue would otherwise make the start's prepare busy and fail it.
        let dequeued: Awaited<ReturnType<RunEngine["dequeueFromWorkerQueue"]>> = [];
        for (let i = 0; i < 25 && dequeued.length === 0; i++) {
          await h.promoter.runQueue.processMasterQueueForEnvironment(h.env.id, 5);
          dequeued = await h.promoter.dequeueFromWorkerQueue({
            consumerId: "pool_settle",
            workerQueue: "main",
          });
          if (dequeued.length === 0) await setTimeout(200);
        }
        expect(dequeued.length).toBe(1);
        const dequeuedRun = await prisma.taskRun.findFirstOrThrow({ where: { id: h.run.id } });
        const strandedId = await h.strandUnit({
          runStatus: dequeuedRun.status,
          snapshot: dequeued[0].snapshot,
        });
        await h.promoter.startRunAttempt({ runId: h.run.id, snapshotId: strandedId });
        expect((await prisma.taskRun.findFirstOrThrow({ where: { id: h.run.id } })).status).toBe(
          "EXECUTING"
        );
        const executing = await h.setup.getRunExecutionData({ runId: h.run.id });
        assertNonNullable(executing);
        expect(executing.snapshot.executionStatus).toBe("EXECUTING");
        expect((await h.snapshotStore.getLatest(h.run.id))?.id).toBe(executing.snapshot.id);
        expect(await h.snapshotStore.hasPreparedUnit(h.run.id)).toBe(false);
      } finally {
        await h.cleanup();
      }
    }
  );

  // The settle before the transaction narrows the window but cannot close it: a unit prepared after
  // the settle still makes the prepare busy. That backstop fails the attempt without replaying the
  // callback. A second writer takes the run's row lock and waits just before its prepare; the promotion
  // settles (nothing is pending yet) and then blocks on that row lock inside its transaction, so the
  // writer's unit is prepared and committed before the promotion's prepare meets it.
  containerTest(
    "a unit prepared after the settle fails the promotion retriably without replaying it",
    async ({ prisma, redisOptions }) => {
      const taskIdentifier = "test-task";
      const h = await parkedMirroredRun(prisma, redisOptions, "run_poolbusy", taskIdentifier);
      let releasePrepare!: () => void;
      const prepareGate = new Promise<void>((resolve) => (releasePrepare = resolve));
      let markAtPrepare!: () => void;
      const atPrepare = new Promise<void>((resolve) => (markAtPrepare = resolve));
      const gatedStore = new RedisSnapshotStore({
        redisOptions,
        completedTtlMs: 60_000,
        beforeCommand: async (operation) => {
          if (operation !== "prepare") return;
          markAtPrepare();
          await prepareGate;
        },
      });
      let late: Promise<unknown> | undefined;
      try {
        const lateWriter = new TaskRunExecutionSnapshotStore(
          new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          {
            store: gatedStore,
            mode: "dual-write",
            resolveDial: () => "dual-write",
            logicalRunStoreRoute: ROUTE,
            hooks: {
              beforeFinalize: () => {
                throw new Error("__crash_before_finalize__");
              },
            },
          }
        );
        const deployed = await setupBackgroundWorker(h.setup, h.env, taskIdentifier);
        const queue = `task/${taskIdentifier}`;
        const lateId = generateInternalId();
        // Like an engine transition, the writer locks the run's row before it writes the snapshot.
        late = lateWriter
          .runInTransaction(h.run.id, async (txStore, tx) => {
            await tx.$queryRawUnsafe('SELECT id FROM "TaskRun" WHERE id = $1 FOR UPDATE', h.run.id);
            await txStore.createExecutionSnapshot(
              {
                id: lateId,
                run: { id: h.run.id, status: "PENDING_VERSION" },
                snapshot: {
                  executionStatus: h.parked.snapshot.executionStatus,
                  description: "Unit prepared after the settle",
                },
                previousSnapshotId: h.parked.snapshot.id,
                environmentId: h.env.id,
                environmentType: h.env.type,
                projectId: h.env.projectId,
                organizationId: h.env.organizationId,
              },
              tx
            );
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        await atPrepare;
        expect(await h.snapshotStore.hasPreparedUnit(h.run.id)).toBe(false);

        const first = h.promoter.pendingVersionSystem
          .enqueueRunsForBackgroundWorker(deployed.worker.id)
          .then(
            () => undefined,
            (error: unknown) => error
          );
        await waitForRowLockWait(prisma);
        releasePrepare();
        expect(((await late) as Error).message).toBe("__crash_before_finalize__");

        const error = await first;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("snapshot prepare rejected: busy");
        // The callback was not replayed: the run is still parked. Its one publish, made before the
        // busy prepare rolled the transaction back, is the message the queue holds.
        expect((await prisma.taskRun.findFirstOrThrow({ where: { id: h.run.id } })).status).toBe(
          "PENDING_VERSION"
        );
        expect(await h.promoter.runQueue.messageExists(h.env.organization.id, h.run.id)).toBe(1);
        expect(await h.promoter.runQueue.lengthOfQueue(h.env, queue)).toBe(1);
        // The late unit was resolved before the failure.
        expect(await h.snapshotStore.hasPreparedUnit(h.run.id)).toBe(false);
        expect((await h.snapshotStore.getLatest(h.run.id))?.id).toBe(lateId);

        // The job's retry promotes the run, and the queue still holds exactly one message for it.
        await h.promoter.pendingVersionSystem.enqueueRunsForBackgroundWorker(deployed.worker.id);
        expect((await prisma.taskRun.findFirstOrThrow({ where: { id: h.run.id } })).status).toBe(
          "PENDING"
        );
        expect(await h.promoter.runQueue.messageExists(h.env.organization.id, h.run.id)).toBe(1);
        expect(await h.promoter.runQueue.lengthOfQueue(h.env, queue)).toBe(1);
        const data = await h.setup.getRunExecutionData({ runId: h.run.id });
        assertNonNullable(data);
        expect(data.snapshot.executionStatus).toBe("QUEUED");
        expect(await h.snapshotStore.hasPreparedUnit(h.run.id)).toBe(false);
      } finally {
        releasePrepare();
        await late;
        await gatedStore.quit();
        await h.cleanup();
      }
    }
  );

  // The resolver cannot settle a unit whose transaction is still open, so it returns with the unit
  // pending. The promotion must fail before its transaction opens, with nothing published, and the
  // job's retry promotes the run once that transaction has committed.
  containerTest(
    "a promotion fails before publishing while an earlier unit's transaction is still open",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const taskIdentifier = "test-task";
      const h = await parkedMirroredRun(prisma, redisOptions, "run_poolheld", taskIdentifier);
      const second = new PrismaClient({
        datasources: { db: { url: postgresContainer.getConnectionUri() } },
      });
      let releaseHeld!: () => void;
      const held = new Promise<void>((resolve) => (releaseHeld = resolve));
      let holding: Promise<unknown> | undefined;
      try {
        // A writer on a second Prisma client prepares its unit inside an interactive transaction that
        // stays open, then crashes before finalize once it commits.
        let markPrepared!: () => void;
        const prepared = new Promise<void>((resolve) => (markPrepared = resolve));
        const holder = new TaskRunExecutionSnapshotStore(
          new PostgresRunStore({ prisma: second, readOnlyPrisma: second }),
          {
            store: h.snapshotStore,
            mode: "dual-write",
            resolveDial: () => "dual-write",
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
        holding = holder
          .createExecutionSnapshot({
            run: { id: h.run.id, status: "PENDING_VERSION" },
            snapshot: {
              executionStatus: h.parked.snapshot.executionStatus,
              description: "Earlier unit, transaction still open",
            },
            previousSnapshotId: h.parked.snapshot.id,
            environmentId: h.env.id,
            environmentType: h.env.type,
            projectId: h.env.projectId,
            organizationId: h.env.organizationId,
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        await prepared;
        expect(await h.snapshotStore.hasPreparedUnit(h.run.id)).toBe(true);

        const deployed = await setupBackgroundWorker(h.setup, h.env, taskIdentifier);
        const queue = `task/${taskIdentifier}`;
        expect(await h.promoter.runQueue.messageExists(h.env.organization.id, h.run.id)).toBe(0);
        expect(await h.promoter.runQueue.lengthOfQueue(h.env, queue)).toBe(0);

        await expect(
          h.promoter.pendingVersionSystem.enqueueRunsForBackgroundWorker(deployed.worker.id)
        ).rejects.toThrow(/^snapshot prepare rejected: busy$/);
        // Nothing reached the run queue and the run is still parked.
        expect(await h.promoter.runQueue.messageExists(h.env.organization.id, h.run.id)).toBe(0);
        expect(await h.promoter.runQueue.lengthOfQueue(h.env, queue)).toBe(0);
        expect((await prisma.taskRun.findFirstOrThrow({ where: { id: h.run.id } })).status).toBe(
          "PENDING_VERSION"
        );
        expect(await h.snapshotStore.hasPreparedUnit(h.run.id)).toBe(true);

        // The held transaction commits; the job's retry settles its unit and promotes the run.
        releaseHeld();
        expect(((await holding) as Error).message).toBe("__crash_before_finalize__");
        await h.promoter.pendingVersionSystem.enqueueRunsForBackgroundWorker(deployed.worker.id);
        expect((await prisma.taskRun.findFirstOrThrow({ where: { id: h.run.id } })).status).toBe(
          "PENDING"
        );
        expect(await h.promoter.runQueue.messageExists(h.env.organization.id, h.run.id)).toBe(1);
        expect(await h.promoter.runQueue.lengthOfQueue(h.env, queue)).toBe(1);
        const data = await h.setup.getRunExecutionData({ runId: h.run.id });
        assertNonNullable(data);
        expect(data.snapshot.executionStatus).toBe("QUEUED");
        expect((await h.snapshotStore.getLatest(h.run.id))?.id).toBe(data.snapshot.id);
        expect(await h.snapshotStore.hasPreparedUnit(h.run.id)).toBe(false);
      } finally {
        releaseHeld();
        await holding;
        await second.$disconnect();
        await h.cleanup();
      }
    }
  );
});
