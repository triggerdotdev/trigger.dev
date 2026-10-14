// Snapshot reads on the dequeue and attempt paths pass the server context they already hold, so the
// snapshot store can route a redis-primary run without a Postgres residency probe. Real Postgres +
// real Redis; the store read is only observed, never stubbed.
import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import type { RedisOptions } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
} from "@internal/run-store";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const taskIdentifier = "test-task";

type Env = Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;

function redisOnlyEngine(prisma: PrismaClient, redisOptions: RedisOptions) {
  const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const engine = new RunEngine({
    prisma,
    store: new TaskRunExecutionSnapshotStore(delegate, {
      store: snapshotStore,
      mode: "redis-only",
      logicalRunStoreRoute: "logical:1",
      resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
    }),
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
  return { engine, snapshotStore };
}

async function triggerRun(engine: RunEngine, env: Env, prisma: PrismaClient, suffix: string) {
  await setupBackgroundWorker(engine, env, taskIdentifier);
  return engine.trigger(
    {
      number: 1,
      friendlyId: `run_readctx${suffix}`,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-readctx${suffix}`,
      spanId: `s-readctx${suffix}`,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );
}

async function dequeue(engine: RunEngine, env: Env) {
  for (let i = 0; i < 25; i++) {
    await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_read_context",
      workerQueue: "main",
    });
    if (dequeued.length > 0) return dequeued[0];
    await setTimeout(200);
  }
  throw new Error("run never reached the worker queue");
}

containerTest(
  "dequeue reads the snapshot with the queue message's redis-primary route",
  async ({ prisma, redisOptions }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
    try {
      const run = await triggerRun(engine, env, prisma, "dq1");
      const reads = vi.spyOn(engine.runStore, "findLatestExecutionSnapshot");

      const dequeued = await dequeue(engine, env);
      expect(dequeued.run.id).toBe(run.id);

      const firstRead = reads.mock.calls.find(([runId]) => runId === run.id);
      expect(firstRead?.[3]).toEqual({
        version: 1,
        residency: "redis-primary",
        organizationId: env.organizationId,
      });
    } finally {
      await engine.quit();
      await snapshotStore.quit();
    }
  }
);
