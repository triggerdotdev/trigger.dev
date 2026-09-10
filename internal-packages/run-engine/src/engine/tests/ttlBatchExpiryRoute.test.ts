// ADDENDUM #1 / BULK TTL: the batch TTL sweep (TtlSystem.expireRunsBatch) classifies by the versioned
// snapshotRoute the TTL Lua copies from each queue message. A VALID carried route is the fast path: the
// resident run advances its MemoryDB head through the per-run protocol with NO durable lookup, never a
// bulk EXPIRED SQL flip while Redis stays QUEUED. An ABSENT or MALFORMED route is NOT assumed Postgres
// (a mixed-version rollout enqueues enrolled runs without a route, and a future version parses as
// absent): those runs alone resolve residency durably, expiring resident runs correctly and taking the
// efficient bulk SQL path only for a CONFIRMED never-enrolled run; an unresolvable residency fails
// closed (skipped). Two engines model two pods sharing one Postgres + Redis + MemoryDB. Real infra.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { createRedisClient } from "@internal/redis";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  SnapshotResidencyResolver,
  snapshotKeys,
  TaskRunExecutionSnapshotStore,
  type SnapshotResidencyReads,
  type SnapshotRouteWire,
  type SnapshotStoreDial,
} from "@internal/run-store";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
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

// Counting instrumentation over the REAL MemoryDB read surface: every durable residency read is delegated
// to the real RedisSnapshotStore and tallied, so a test can assert a path performed ZERO durable
// residency resolution (rather than inferring it from the absence of a thrown error).
class CountingReads implements SnapshotResidencyReads {
  stateVersion = 0;
  birthResidency = 0;
  pendingState = 0;
  constructor(private readonly inner: SnapshotResidencyReads) {}
  readStateVersion(runId: string) {
    this.stateVersion++;
    return this.inner.readStateVersion(runId);
  }
  readBirthResidency(runId: string) {
    this.birthResidency++;
    return this.inner.readBirthResidency(runId);
  }
  readPendingState(runId: string) {
    this.pendingState++;
    return this.inner.readPendingState(runId);
  }
  get total(): number {
    return this.stateVersion + this.birthResidency + this.pendingState;
  }
}

// A REAL resolver over the real RedisSnapshotStore and the real Prisma existence query, with both the
// durable reads and the existence probe counted. Lets the sweep assert the fast path did no durable
// residency resolution and no existence query.
function countingResolver(snapshotStore: RedisSnapshotStore, prisma: any) {
  const reads = new CountingReads(snapshotStore);
  let existenceQueries = 0;
  const resolver = new SnapshotResidencyResolver({
    store: reads,
    taskRunExists: async (id: string) => {
      existenceQueries++;
      return (await prisma.taskRun.count({ where: { id } })) > 0;
    },
  });
  return { resolver, reads, existenceCount: () => existenceQueries };
}

function makeEngine(
  prisma: any,
  redisOptions: any,
  snapshotStore: RedisSnapshotStore,
  dial: () => SnapshotStoreDial | undefined,
  resolver?: SnapshotResidencyResolver
) {
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const store = new TaskRunExecutionSnapshotStore(delegate, {
    store: snapshotStore,
    mode: "redis-only",
    resolveDial: dial,
    residencyResolver:
      resolver ??
      new SnapshotResidencyResolver({
        store: snapshotStore,
        taskRunExists: async (id: string) => (await prisma.taskRun.count({ where: { id } })) > 0,
      }),
    resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
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
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

// A sweep-driving engine: the redis-worker and the queue's TTL consumer are BOTH enabled, so a
// triggered run flows all the way through the real TTL Lua -> expireTtlRun job -> expireRunsBatch,
// exercising the Lua's snapshotRoute copy end to end (no direct expireRunsBatch call).
function makeSweepEngine(
  prisma: any,
  redisOptions: any,
  snapshotStore: RedisSnapshotStore,
  dial: () => SnapshotStoreDial | undefined,
  resolver?: SnapshotResidencyResolver
) {
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const store = new TaskRunExecutionSnapshotStore(delegate, {
    store: snapshotStore,
    mode: "redis-only",
    resolveDial: dial,
    residencyResolver:
      resolver ??
      new SnapshotResidencyResolver({
        store: snapshotStore,
        taskRunExists: async (id: string) => (await prisma.taskRun.count({ where: { id } })) > 0,
      }),
    resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
    logicalRunStoreRoute: ROUTE,
  });
  return new RunEngine({
    prisma,
    store,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
      ttlSystem: { pollIntervalMs: 100, batchSize: 10, batchMaxWaitMs: 100 },
    },
    runLock: { redis: redisOptions },
    machines,
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

function triggerInput(env: any, friendlyId: string, tag: string, ttl = "60s") {
  return {
    number: 1,
    friendlyId,
    environment: env,
    taskIdentifier: "test-task",
    payload: "{}",
    payloadType: "application/json",
    context: {},
    traceContext: {},
    traceId: `t-${tag}`,
    spanId: `s-${tag}`,
    workerQueue: "main",
    queue: "task/test-task",
    isTest: false,
    tags: [],
    ttl,
  };
}

function wireRoute(organizationId: string): SnapshotRouteWire {
  return { version: 1, residency: "redis-primary", organizationId };
}

function postgresWireRoute(organizationId: string): SnapshotRouteWire {
  return { version: 1, residency: "postgres", organizationId };
}

describe("RunEngine TTL batch expiry snapshot route (ADDENDUM #1 / BULK TTL)", () => {
  containerTest(
    "a CARRIED valid route drives the resident per-run protocol: a redis-primary run advances its MemoryDB head to FINISHED (no TRES), not a bulk EXPIRED flip",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const producer = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-only");
      const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);

      try {
        await setupBackgroundWorker(producer, env, "test-task");

        // Redis-primary birth: no TRES row, head is QUEUED-ish in MemoryDB.
        const rp = await producer.trigger(triggerInput(env, "run_rp", "rp"), prisma);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: rp.id } })).toBe(0);

        // The batch carries the route (as the TTL Lua copies it from the message). The undefined-dial
        // consumer does NO durable lookup; the carried route routes the resident run through the per-run
        // protocol so its head advances to FINISHED in MemoryDB.
        const result = await consumer.ttlSystem.expireRunsBatch([
          { runId: rp.id, snapshotRoute: wireRoute(env.organization.id) },
        ]);
        expect(result.expired).toContain(rp.id);

        const rpData = await consumer.getRunExecutionData({ runId: rp.id });
        assertNonNullable(rpData);
        expect(rpData.snapshot.executionStatus).toBe("FINISHED");
        expect(rpData.run.status).toBe("EXPIRED");
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: rp.id } })).toBe(0);
        const rpHead = await snapshotStore.getLatest(rp.id);
        assertNonNullable(rpHead);
        expect(rpHead.id).toBe(rpData.snapshot.id);
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "an ABSENT route takes the efficient bulk SQL path: a never-enrolled Postgres run flips to EXPIRED",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      // dial undefined at birth: the run is postgres-resident, its queue message carries no route.
      const producer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);
      const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);

      try {
        await setupBackgroundWorker(producer, env, "test-task");
        const pg = await producer.trigger(triggerInput(env, "run_pg", "pg"), prisma);

        const result = await consumer.ttlSystem.expireRunsBatch([
          { runId: pg.id, snapshotRoute: undefined },
        ]);
        expect(result.expired).toContain(pg.id);

        const run = await prisma.taskRun.findFirstOrThrow({ where: { id: pg.id } });
        expect(run.status).toBe("EXPIRED");
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "a CARRIED valid POSTGRES route takes the efficient bulk SQL path: the run flips to EXPIRED with NO per-run FINISHED snapshot write",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      // Born POSTGRES-resident (dial undefined -> a TRES birth row, no MemoryDB state), so its message
      // carries an explicit `postgres` route. A postgres route must NOT drive the per-run resident
      // protocol (which would lock + write a second FINISHED snapshot row); it takes efficient bulk SQL.
      const producer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);
      const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);

      try {
        await setupBackgroundWorker(producer, env, "test-task");
        const pg = await producer.trigger(triggerInput(env, "run_pgroute", "pgr"), prisma);
        const snapsBefore = await prisma.taskRunExecutionSnapshot.count({
          where: { runId: pg.id },
        });
        expect(snapsBefore).toBeGreaterThan(0); // a postgres birth writes a TRES snapshot row

        const result = await consumer.ttlSystem.expireRunsBatch([
          { runId: pg.id, snapshotRoute: postgresWireRoute(env.organization.id) },
        ]);
        expect(result.expired).toContain(pg.id);

        const run = await prisma.taskRun.findFirstOrThrow({ where: { id: pg.id } });
        expect(run.status).toBe("EXPIRED");
        // Bulk SQL sets status directly and writes no execution snapshot. The resident per-run path would
        // have written a new FINISHED snapshot, so an unchanged count proves the bulk path was taken.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: pg.id } })).toBe(
          snapsBefore
        );
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "PRODUCTION birth: a decorated Postgres birth stamps an explicit {version:1,residency:postgres} route on the queue message with no durable lookup",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      // Both pods dial undefined -> a Postgres birth. Real resolver (dequeue legitimately resolves a
      // postgres run's residency to read its snapshot); this test proves the emitted route value.
      const producer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);
      const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);

      async function dequeueOnConsumer() {
        for (let i = 0; i < 25; i++) {
          await producer.runQueue.processMasterQueueForEnvironment(env.id, 5);
          const dequeued = await consumer.dequeueFromWorkerQueue({
            consumerId: "birth_consumer",
            workerQueue: "main",
          });
          if (dequeued.length > 0) return dequeued[0];
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error("run never reached the worker queue");
      }

      try {
        await setupBackgroundWorker(producer, env, "test-task");
        // Real trigger -> real createRun -> onBirthResidency -> real enqueue.
        const pg = await producer.trigger(triggerInput(env, "run_birthroute", "br"), prisma);
        // Postgres birth writes a TRES row and no MemoryDB state.
        expect(
          await prisma.taskRunExecutionSnapshot.count({ where: { runId: pg.id } })
        ).toBeGreaterThan(0);

        const dequeued = await dequeueOnConsumer();
        expect(dequeued.run.id).toBe(pg.id);
        // The exact route the production path stamped. Removing the Postgres onBirthResidency callback
        // leaves this undefined (RED).
        expect(dequeued.snapshotRoute).toEqual({
          version: 1,
          residency: "postgres",
          organizationId: env.organization.id,
        });
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "PRODUCTION sweep: a decorated Postgres birth's carried route lets the real TTL sweep expire it via bulk SQL with NO durable residency resolution",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      // dial undefined -> Postgres birth. The resolver is REAL (over the real store + Prisma), but every
      // durable residency read and existence query is counted. On the fast path the birth-stamped route is
      // copied by the TTL Lua and classified as postgres (bulk SQL), so NO durable residency resolution
      // runs and all counters stay zero. Remove the Postgres onBirthResidency callback and the route-less
      // message sends the batch into durable resolution, moving the read counter off zero (RED).
      const instr = countingResolver(snapshotStore, prisma);
      const engine = makeSweepEngine(
        prisma,
        redisOptions,
        snapshotStore,
        () => undefined,
        instr.resolver
      );

      try {
        await setupBackgroundWorker(engine, env, "test-task");
        await engine.runQueue.updateEnvConcurrencyLimits({ ...env, maximumConcurrencyLimit: 0 });

        const pg = await engine.trigger(triggerInput(env, "run_birthsweep", "bs", "1s"), prisma);

        let status: string | undefined;
        for (let i = 0; i < 100; i++) {
          const run = await prisma.taskRun.findFirstOrThrow({ where: { id: pg.id } });
          status = run.status;
          if (status === "EXPIRED") break;
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(status).toBe("EXPIRED");
        // The fast path resolved residency from the carried route alone: no durable reads, no existence
        // query. The read counter is the RED discriminator (compat resolution moves it off zero).
        expect(instr.reads.total).toBe(0);
        expect(instr.existenceCount()).toBe(0);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "an ABSENT or MALFORMED route on an ENROLLED run resolves durably (mixed-version), never stranded as Postgres",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const producer = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-only");
      const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);

      try {
        await setupBackgroundWorker(producer, env, "test-task");

        // A redis-primary run whose message carries NO route (an older pod enqueued it mid-rollout) and
        // one whose route is a future/unknown version that parses as absent. Neither may be assumed
        // Postgres: the batch resolves each residency durably and expires it through the resident protocol.
        const rpAbsent = await producer.trigger(triggerInput(env, "run_mva", "mva"), prisma);
        const rpMalformed = await producer.trigger(triggerInput(env, "run_mvm", "mvm"), prisma);

        const result = await consumer.ttlSystem.expireRunsBatch([
          { runId: rpAbsent.id, snapshotRoute: undefined },
          { runId: rpMalformed.id, snapshotRoute: { version: 99, residency: "redis-primary" } },
        ]);
        expect(result.expired).toEqual(expect.arrayContaining([rpAbsent.id, rpMalformed.id]));

        for (const id of [rpAbsent.id, rpMalformed.id]) {
          const data = await consumer.getRunExecutionData({ runId: id });
          assertNonNullable(data);
          expect(data.snapshot.executionStatus).toBe("FINISHED");
          expect(data.run.status).toBe("EXPIRED");
          // Advanced in MemoryDB, not flipped only in Postgres.
          expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: id } })).toBe(0);
          const head = await snapshotStore.getLatest(id);
          assertNonNullable(head);
          expect(head.id).toBe(data.snapshot.id);
        }
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "a route-less run whose durable residency cannot be resolved fails the batch so the worker retries, never orphaning it",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const producer = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-only");
      const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);

      try {
        await setupBackgroundWorker(producer, env, "test-task");
        const rp = await producer.trigger(triggerInput(env, "run_fc", "fc"), prisma);

        // Evict the redis-primary state (keep the residency marker): durable resolution now fails closed.
        const k = snapshotKeys(rp.id);
        const raw = createRedisClient(redisOptions, { onError: () => {} });
        await raw.del(k.e, k.idx, k.cur, k.seq);
        await raw.quit();

        // The Lua already dequeued this run, so a swallowed skip would orphan it. The batch must THROW so
        // the redis-worker retries the item instead of ACK-ing it.
        await expect(
          consumer.ttlSystem.expireRunsBatch([{ runId: rp.id, snapshotRoute: undefined }])
        ).rejects.toThrow();

        // Not flipped to EXPIRED by a bulk SQL guess; it stays PENDING for the retry to pick up.
        const run = await prisma.taskRun.findFirstOrThrow({ where: { id: rp.id } });
        expect(run.status).toBe("PENDING");
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: rp.id } })).toBe(0);
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "end to end: the real TTL Lua copies the message route so a swept redis-primary run advances its MemoryDB head, never a Postgres-only bulk flip",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const engine = makeSweepEngine(prisma, redisOptions, snapshotStore, () => "redis-only");

      try {
        await setupBackgroundWorker(engine, env, "test-task");
        // Force env concurrency to 0 so the run stays queued in the TTL set until the sweep expires it.
        await engine.runQueue.updateEnvConcurrencyLimits({ ...env, maximumConcurrencyLimit: 0 });

        const rp = await engine.trigger(triggerInput(env, "run_e2e", "e2e", "1s"), prisma);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: rp.id } })).toBe(0);

        // Wait for the real sweep (Lua -> expireTtlRun job -> expireRunsBatch) to expire it.
        let status: string | undefined;
        for (let i = 0; i < 100; i++) {
          const run = await prisma.taskRun.findFirstOrThrow({ where: { id: rp.id } });
          status = run.status;
          if (status === "EXPIRED") break;
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(status).toBe("EXPIRED");

        // The route the Lua copied drove the resident per-run protocol: the MemoryDB head is FINISHED and
        // no TRES row was written. Without the Lua copy the batch would take the Postgres bulk path,
        // leaving the MemoryDB head un-advanced.
        const data = await engine.getRunExecutionData({ runId: rp.id });
        assertNonNullable(data);
        expect(data.snapshot.executionStatus).toBe("FINISHED");
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: rp.id } })).toBe(0);
        const head = await snapshotStore.getLatest(rp.id);
        assertNonNullable(head);
        expect(head.id).toBe(data.snapshot.id);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});
