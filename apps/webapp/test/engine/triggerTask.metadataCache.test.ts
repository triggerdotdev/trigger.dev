import { describe, expect, onTestFinished, vi } from "vitest";

// db.server + splitMode are mocked so the idempotency dedup client resolves to
// the container prisma passed into the concern (split stays off).
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
}));

vi.mock("~/v3/runOpsMigration/splitMode.server", () => ({ isSplitEnabled: async () => false }));

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEntitlement: vi.fn(),
  };
});

import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { Redis } from "ioredis";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { RedisTaskMetadataCache } from "~/services/taskMetadataCache.server";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import { setTimeout } from "node:timers/promises";
import {
  MockPayloadProcessor,
  MockTraceEventConcern,
  MockTriggerTaskValidator,
} from "./triggerTaskTestHelpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("DefaultQueueManager task metadata cache", () => {
  containerTest(
    "warm cache returns metadata without falling through to PG",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "cached-task";
      const setup = await setupBackgroundWorker(engine, environment, taskIdentifier);

      const redis = new Redis(redisOptions);
      onTestFinished(() => redis.quit());
      const cache = new RedisTaskMetadataCache({ redis });

      // Pre-populate cache with AGENT triggerSource; DB row has the default STANDARD.
      // If the read path hits the cache, the resulting TaskRun.taskKind reflects the
      // cached value. If it falls through to PG, it reflects STANDARD.
      await cache.populateByCurrentWorker(environment.id, setup.worker.id, [
        {
          slug: taskIdentifier,
          ttl: null,
          triggerSource: "AGENT",
          queueId: null,
          queueName: `task/${taskIdentifier}`,
        },
      ]);

      const queuesManager = new DefaultQueueManager(prisma, engine, undefined, cache);
      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern: new IdempotencyKeyConcern(
          prisma,
          engine,
          new MockTraceEventConcern()
        ),
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
      });

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" } },
      });

      assertNonNullable(result);
      expect(result.run.taskIdentifier).toBe(taskIdentifier);
      expect((result.run.annotations as { taskKind?: string } | null)?.taskKind).toBe("AGENT");
    }
  );

  containerTest(
    "cache miss falls through to PG and back-fills the cache",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "miss-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const redis = new Redis(redisOptions);
      onTestFinished(() => redis.quit());
      const cache = new RedisTaskMetadataCache({ redis });

      // Cache starts empty. Sanity-check both keyspaces.
      expect(await cache.getCurrent(environment.id, taskIdentifier)).toBeNull();

      const queuesManager = new DefaultQueueManager(prisma, engine, undefined, cache);
      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern: new IdempotencyKeyConcern(
          prisma,
          engine,
          new MockTraceEventConcern()
        ),
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
      });

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" } },
      });

      assertNonNullable(result);
      expect((result.run.annotations as { taskKind?: string } | null)?.taskKind).toBe("STANDARD");

      // Back-fill is fire-and-forget; poll with a bounded timeout to avoid CI flakes.
      let backfilled = await cache.getCurrent(environment.id, taskIdentifier);
      for (let i = 0; i < 40 && !backfilled; i++) {
        await setTimeout(25);
        backfilled = await cache.getCurrent(environment.id, taskIdentifier);
      }
      expect(backfilled).not.toBeNull();
      expect(backfilled?.triggerSource).toBe("STANDARD");
      expect(backfilled?.queueName).toBe(`task/${taskIdentifier}`);
    }
  );

  containerTest(
    "queue-override + ttl path returns taskKind from cache without a BWT lookup",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "override-task";
      const setup = await setupBackgroundWorker(engine, environment, taskIdentifier);

      const redis = new Redis(redisOptions);
      onTestFinished(() => redis.quit());
      const cache = new RedisTaskMetadataCache({ redis });

      // Cache says AGENT; DB row says STANDARD. Caller provides both a queue
      // override and an explicit TTL — the hot path the PR regressed.
      await cache.populateByCurrentWorker(environment.id, setup.worker.id, [
        {
          slug: taskIdentifier,
          ttl: null,
          triggerSource: "AGENT",
          queueId: null,
          queueName: `task/${taskIdentifier}`,
        },
      ]);

      const queuesManager = new DefaultQueueManager(prisma, engine, undefined, cache);
      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern: new IdempotencyKeyConcern(
          prisma,
          engine,
          new MockTraceEventConcern()
        ),
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
      });

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment,
        body: {
          payload: { test: "x" },
          options: {
            queue: { name: "caller-queue" },
            ttl: "5m",
          },
        },
      });

      assertNonNullable(result);
      expect(result.run.queue).toBe("caller-queue");
      expect((result.run.annotations as { taskKind?: string } | null)?.taskKind).toBe("AGENT");
    }
  );

  containerTest(
    "locked-version trigger reads from by-worker keyspace, not env keyspace",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "keyspace-task";
      const worker = await setupBackgroundWorker(engine, environment, taskIdentifier);

      const redis = new Redis(redisOptions);
      onTestFinished(() => redis.quit());
      const cache = new RedisTaskMetadataCache({ redis });

      // Populate the two keyspaces with conflicting triggerSource values so we
      // can tell which keyspace the read used. The real worker's by-worker
      // hash gets AGENT; the env hash gets SCHEDULED (seeded via a throwaway
      // worker id since `populateByCurrentWorker` writes both keyspaces and
      // we want the real worker's by-worker hash untouched).
      await cache.populateByWorker(worker.worker.id, [
        {
          slug: taskIdentifier,
          ttl: null,
          triggerSource: "AGENT",
          queueId: null,
          queueName: `task/${taskIdentifier}`,
        },
      ]);
      await cache.populateByCurrentWorker(environment.id, "dummy-worker-for-env-seed", [
        {
          slug: taskIdentifier,
          ttl: null,
          triggerSource: "SCHEDULED",
          queueId: null,
          queueName: `task/${taskIdentifier}`,
        },
      ]);

      const queuesManager = new DefaultQueueManager(prisma, engine, undefined, cache);
      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern: new IdempotencyKeyConcern(
          prisma,
          engine,
          new MockTraceEventConcern()
        ),
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
      });

      // Locked → by-worker keyspace → AGENT
      const locked = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment,
        body: {
          payload: { test: "x" },
          options: { lockToVersion: worker.worker.version },
        },
      });
      assertNonNullable(locked);
      expect((locked.run.annotations as { taskKind?: string } | null)?.taskKind).toBe("AGENT");

      // Not locked → env keyspace → SCHEDULED
      const current = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "y" } },
      });
      assertNonNullable(current);
      expect((current.run.annotations as { taskKind?: string } | null)?.taskKind).toBe("SCHEDULED");
    }
  );
});
