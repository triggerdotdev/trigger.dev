// P3 correction, Item 2: the SCHEDULED expiry writers (TtlSystem.expireRun and the expiry branch of
// PendingVersionSystem.expireParkedExternalDeploymentRun) mint a TERMINAL snapshot on any pod. Like
// every other lifecycle transition they must carry the run's durable route, or a poll-lagging pod
// (org dial reads undefined) writes the terminal snapshot to the never-enrolled Postgres shortcut —
// stranding a redis-primary run's head in MemoryDB while a terminal TRES row appears in Postgres.
// Two engines model two pods sharing one Postgres + Redis + MemoryDB: a PRODUCER births the run, an
// undefined-dial CONSUMER drives the expiry. Real infra, no mocks.
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

function makeEngine(
  prisma: any,
  redisOptions: any,
  snapshotStore: RedisSnapshotStore,
  dial: () => SnapshotStoreDial | undefined
) {
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const store = new TaskRunExecutionSnapshotStore(delegate, {
    store: snapshotStore,
    mode: "redis-only",
    resolveDial: dial,
    residencyResolver: new SnapshotResidencyResolver({
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

function triggerInput(env: any, friendlyId: string, tag: string) {
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
    ttl: "60s",
  };
}

function parkedTriggerInput(
  env: any,
  friendlyId: string,
  tag: string,
  externalDeploymentId: string
) {
  return {
    ...triggerInput(env, friendlyId, tag),
    ttl: undefined,
    annotations: {
      triggerSource: "sdk",
      triggerAction: "trigger",
      rootTriggerSource: "sdk",
      externalDeploymentId,
    },
    parkedOnExternalDeploymentId: externalDeploymentId,
  };
}

describe("RunEngine expiry snapshot route (P3 correction, Item 2)", () => {
  containerTest(
    "ttl expireRun on a dial=undefined consumer: redis-primary stays in MemoryDB with no TRES; mirrored advances both stores to the same terminal head",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const producerRedisPrimary = makeEngine(
        prisma,
        redisOptions,
        snapshotStore,
        () => "redis-only"
      );
      const producerMirrored = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-read");
      const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);

      try {
        await setupBackgroundWorker(producerRedisPrimary, env, "test-task");

        // Redis-primary birth: no TRES row.
        const rp = await producerRedisPrimary.trigger(triggerInput(env, "run_rp", "rp"), prisma);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: rp.id } })).toBe(0);

        // The undefined-dial consumer expires it. The terminal snapshot carries the durable route, so
        // it stays redis-primary: head advances in MemoryDB, still no TRES row.
        await consumer.ttlSystem.expireRun({ runId: rp.id });
        const rpData = await consumer.getRunExecutionData({ runId: rp.id });
        assertNonNullable(rpData);
        expect(rpData.snapshot.executionStatus).toBe("FINISHED");
        expect(rpData.run.status).toBe("EXPIRED");
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: rp.id } })).toBe(0);
        const rpHead = await snapshotStore.getLatest(rp.id);
        assertNonNullable(rpHead);
        expect(rpHead.id).toBe(rpData.snapshot.id);

        // Mirrored birth: the same expiry advances BOTH Postgres and MemoryDB to the same terminal head.
        const mr = await producerMirrored.trigger(triggerInput(env, "run_mr", "mr"), prisma);
        await consumer.ttlSystem.expireRun({ runId: mr.id });
        const mrData = await consumer.getRunExecutionData({ runId: mr.id });
        assertNonNullable(mrData);
        expect(mrData.snapshot.executionStatus).toBe("FINISHED");
        const terminalId = mrData.snapshot.id;
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { id: terminalId } })).toBe(1);
        const mrHead = await snapshotStore.getLatest(mr.id);
        assertNonNullable(mrHead);
        expect(mrHead.id).toBe(terminalId);
      } finally {
        await producerRedisPrimary.quit();
        await producerMirrored.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "ttl expireRun fails closed when the durable route cannot be resolved: no terminal TRES row",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const producer = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-only");
      const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);

      try {
        await setupBackgroundWorker(producer, env, "test-task");
        const rp = await producer.trigger(triggerInput(env, "run_fc", "fc"), prisma);

        // Evict the redis-primary state (keep the permanent residency marker): the durable route is now
        // unresolvable. The expiry must fail closed rather than divert the terminal write to Postgres.
        const k = snapshotKeys(rp.id);
        const raw = createRedisClient(redisOptions, { onError: () => {} });
        await raw.del(k.e, k.idx, k.cur, k.seq);
        await raw.quit();

        await expect(consumer.ttlSystem.expireRun({ runId: rp.id })).rejects.toThrow();
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: rp.id } })).toBe(0);
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "expireParkedExternalDeploymentRun on a dial=undefined consumer: redis-primary stays in MemoryDB with no TRES; mirrored advances both stores; unresolvable route fails closed",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const producerRedisPrimary = makeEngine(
        prisma,
        redisOptions,
        snapshotStore,
        () => "redis-only"
      );
      const producerMirrored = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-read");
      const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);

      try {
        await setupBackgroundWorker(producerRedisPrimary, env, "test-task");

        // Redis-primary parked run: no deployment holds the id, so the expiry proceeds to a terminal
        // snapshot carrying the durable route -> stays redis-primary, no TRES row.
        const rp = await producerRedisPrimary.trigger(
          parkedTriggerInput(env, "park_rp", "prp", "commit-rp") as any,
          prisma
        );
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: rp.id } })).toBe(0);
        await consumer.pendingVersionSystem.expireParkedExternalDeploymentRun({
          runId: rp.id,
          externalDeploymentId: "commit-rp",
        });
        const rpData = await consumer.getRunExecutionData({ runId: rp.id });
        assertNonNullable(rpData);
        expect(rpData.snapshot.executionStatus).toBe("FINISHED");
        expect(rpData.run.status).toBe("EXPIRED");
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: rp.id } })).toBe(0);

        // Mirrored parked run: the same expiry advances BOTH stores to the same terminal head.
        const mr = await producerMirrored.trigger(
          parkedTriggerInput(env, "park_mr", "pmr", "commit-mr") as any,
          prisma
        );
        await consumer.pendingVersionSystem.expireParkedExternalDeploymentRun({
          runId: mr.id,
          externalDeploymentId: "commit-mr",
        });
        const mrData = await consumer.getRunExecutionData({ runId: mr.id });
        assertNonNullable(mrData);
        expect(mrData.snapshot.executionStatus).toBe("FINISHED");
        expect(
          await prisma.taskRunExecutionSnapshot.count({ where: { id: mrData.snapshot.id } })
        ).toBe(1);
        const mrHead = await snapshotStore.getLatest(mr.id);
        assertNonNullable(mrHead);
        expect(mrHead.id).toBe(mrData.snapshot.id);

        // Unresolvable durable route: evict the redis-primary state and the expiry fails closed with no
        // terminal TRES row.
        const fc = await producerRedisPrimary.trigger(
          parkedTriggerInput(env, "park_fc", "pfc", "commit-fc") as any,
          prisma
        );
        const k = snapshotKeys(fc.id);
        const raw = createRedisClient(redisOptions, { onError: () => {} });
        await raw.del(k.e, k.idx, k.cur, k.seq);
        await raw.quit();
        await expect(
          consumer.pendingVersionSystem.expireParkedExternalDeploymentRun({
            runId: fc.id,
            externalDeploymentId: "commit-fc",
          })
        ).rejects.toThrow();
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: fc.id } })).toBe(0);
      } finally {
        await producerRedisPrimary.quit();
        await producerMirrored.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );
});
