// The per-run expireRun job is armed for DEVELOPMENT runs with a TTL and is only acked when an
// attempt starts, so a dev run cancelled before it starts keeps the job armed. If the TTL outlives
// the run's MemoryDB snapshot state, the job fires after that state has expired: the snapshot read
// is permanently unservable, and the job must complete against the final run row instead of retrying
// until it dead-letters. A transient MemoryDB error must keep failing closed. Real Postgres + real
// Redis, no mocks.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { RedisOptions } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  SnapshotReadUnavailableError,
  SnapshotStateExpiredError,
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

// A DEVELOPMENT run with a TTL longer than the post-finish snapshot state lifetime.
async function triggerDevRunWithTtl(engine: RunEngine, env: Env, prisma: PrismaClient, n: number) {
  return engine.trigger(
    {
      number: n,
      friendlyId: `run_ttlexpired${n}`,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-ttlexpired${n}`,
      spanId: `s-ttlexpired${n}`,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
      ttl: "10d",
    },
    prisma
  );
}

describe("expireRun with expired redis-primary snapshot state", () => {
  containerTest(
    "a DEV run cancelled before it started, with expired snapshot state, completes without expiring",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "DEVELOPMENT");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerDevRunWithTtl(engine, env, prisma, 1);
        expect(await snapshotStore.readBirthResidency(run.id)).toBe("redis-primary");

        // Not executing, so cancellation finishes the run straight away.
        const cancelled = await engine.cancelRun({ runId: run.id, reason: "stop" });
        expect(cancelled.snapshot.executionStatus).toBe("FINISHED");
        const head = await snapshotStore.getLatest(run.id);
        assertNonNullable(head);
        expect(head.entry.executionStatus).toBe("FINISHED");

        // What the post-finish TTL does: the run's MemoryDB state is gone, the residency marker survives.
        await snapshotStore.dropRun(run.id);
        expect(await snapshotStore.getLatest(run.id)).toBeNull();
        expect(await snapshotStore.readBirthResidency(run.id)).toBe("redis-primary");

        await expect(
          engine.ttlSystem.expireRun({ runId: run.id, organizationId: env.organization.id })
        ).resolves.toBeUndefined();

        const row = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(row.status).toBe("CANCELED");
        expect(row.expiredAt).toBeNull();
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "a finished DEV run with MemoryDB unavailable still fails closed and retriable",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "DEVELOPMENT");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerDevRunWithTtl(engine, env, prisma, 2);
        const cancelled = await engine.cancelRun({ runId: run.id, reason: "stop" });
        expect(cancelled.snapshot.executionStatus).toBe("FINISHED");

        // The snapshot store's MemoryDB client goes away; the rest of the engine's Redis is fine.
        await snapshotStore.quit();

        let error: unknown;
        try {
          await engine.ttlSystem.expireRun({ runId: run.id, organizationId: env.organization.id });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(SnapshotReadUnavailableError);
        expect(error).not.toBeInstanceOf(SnapshotStateExpiredError);
        expect((error as SnapshotReadUnavailableError).retriable).toBe(true);

        const row = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(row.status).toBe("CANCELED");
        expect(row.expiredAt).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );
  containerTest(
    "a PENDING DEV run with expired snapshot state fails closed and is not expired",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "DEVELOPMENT");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerDevRunWithTtl(engine, env, prisma, 3);
        const before = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(before.status).toBe("PENDING");

        // Expired state with a non-final row is lost state, not a finished run.
        await snapshotStore.dropRun(run.id);
        expect(await snapshotStore.getLatest(run.id)).toBeNull();
        expect(await snapshotStore.readBirthResidency(run.id)).toBe("redis-primary");

        let error: unknown;
        try {
          await engine.ttlSystem.expireRun({ runId: run.id, organizationId: env.organization.id });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(SnapshotStateExpiredError);

        const row = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(row.status).toBe("PENDING");
        expect(row.expiredAt).toBeNull();
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});
