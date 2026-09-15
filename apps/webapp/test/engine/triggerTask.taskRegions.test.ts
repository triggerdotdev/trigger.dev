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
import type { PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "ioredis";
import { Redis } from "ioredis";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { RedisTaskMetadataCache } from "~/services/taskMetadataCache.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import {
  MockPayloadProcessor,
  MockTraceEventConcern,
  MockTriggerTaskValidator,
} from "./triggerTaskTestHelpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function createEngine(prisma: PrismaClient, redisOptions: RedisOptions) {
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
  return engine;
}

function createTriggerService(engine: RunEngine, prisma: PrismaClient, redisOptions: RedisOptions) {
  const redis = new Redis(redisOptions);
  onTestFinished(() => redis.quit());
  // A fresh, empty cache so the first trigger reads the task row (and its
  // regions) from Postgres and back-fills from there.
  const cache = new RedisTaskMetadataCache({ redis });

  return new RunEngineTriggerTaskService({
    engine,
    prisma,
    payloadProcessor: new MockPayloadProcessor(),
    queueConcern: new DefaultQueueManager(prisma, engine, undefined, cache),
    idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
    validator: new MockTriggerTaskValidator(),
    traceEventConcern: new MockTraceEventConcern(),
    tracer: trace.getTracer("test", "0.0.0"),
    metadataMaximumSize: 1024 * 1024,
  });
}

// `setupAuthenticatedEnvironment` seeds one MANAGED group ("default") and makes it
// the project default; this adds a second region to route to.
async function seedRegion(prisma: PrismaClient, masterQueue: string) {
  return prisma.workerInstanceGroup.create({
    data: {
      name: masterQueue,
      masterQueue,
      type: "MANAGED",
      token: { create: { tokenHash: `token_${masterQueue}` } },
    },
  });
}

async function setTaskRegions(
  prisma: PrismaClient,
  workerId: string,
  slug: string,
  regions: string[]
) {
  await prisma.backgroundWorkerTask.update({
    where: { workerId_slug: { workerId, slug } },
    data: { regions },
  });
}

describe("RunEngineTriggerTaskService task-level regions", () => {
  containerTest(
    "places runs in the first listed region when the project default is not allowed",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "eu-only-task";
      const setup = await setupBackgroundWorker(engine, environment, taskIdentifier);
      await seedRegion(prisma, "eu-central-1");
      await setTaskRegions(prisma, setup.worker.id, taskIdentifier, ["eu-central-1"]);

      const service = createTriggerService(engine, prisma, redisOptions);
      const result = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" } },
      });

      assertNonNullable(result);
      expect(result.run.workerQueue).toBe("eu-central-1");
      expect(result.run.region).toBe("eu-central-1");
    }
  );

  containerTest(
    "prefers the project default region when the task allows it",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "multi-region-task";
      const setup = await setupBackgroundWorker(engine, environment, taskIdentifier);
      await seedRegion(prisma, "eu-central-1");
      // "default" is the project default but listed second: the default still wins.
      await setTaskRegions(prisma, setup.worker.id, taskIdentifier, ["eu-central-1", "default"]);

      const service = createTriggerService(engine, prisma, redisOptions);
      const result = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" } },
      });

      assertNonNullable(result);
      expect(result.run.workerQueue).toBe("default");
      expect(result.run.region).toBe("default");
    }
  );

  containerTest(
    "honours a per-trigger region inside the list and rejects one outside it with a 400",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "eu-only-task";
      const setup = await setupBackgroundWorker(engine, environment, taskIdentifier);
      await seedRegion(prisma, "eu-central-1");
      await setTaskRegions(prisma, setup.worker.id, taskIdentifier, ["eu-central-1"]);

      const service = createTriggerService(engine, prisma, redisOptions);

      const allowed = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" }, options: { region: "eu-central-1" } },
      });
      assertNonNullable(allowed);
      expect(allowed.run.workerQueue).toBe("eu-central-1");

      let caught: unknown;
      try {
        await service.call({
          taskId: taskIdentifier,
          environment,
          body: { payload: { test: "y" }, options: { region: "default" } },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ServiceValidationError);
      const validationError = caught as ServiceValidationError;
      expect(validationError.status).toBe(400);
      expect(validationError.message).toBe(
        'Task "eu-only-task" can only run in: eu-central-1. You specified "default".'
      );
    }
  );

  containerTest(
    "uses the locked worker version's regions for a locked trigger",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "locked-task";
      const setup = await setupBackgroundWorker(engine, environment, taskIdentifier);
      await seedRegion(prisma, "eu-central-1");
      await setTaskRegions(prisma, setup.worker.id, taskIdentifier, ["eu-central-1"]);

      const service = createTriggerService(engine, prisma, redisOptions);
      const result = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" }, options: { lockToVersion: setup.worker.version } },
      });

      assertNonNullable(result);
      expect(result.run.workerQueue).toBe("eu-central-1");
    }
  );

  containerTest("ignores task regions in dev environments", async ({ prisma, redisOptions }) => {
    const engine = createEngine(prisma, redisOptions);
    const environment = await setupAuthenticatedEnvironment(prisma, "DEVELOPMENT");
    const taskIdentifier = "eu-only-task";
    const setup = await setupBackgroundWorker(engine, environment, taskIdentifier);
    // The region does not even need to exist: dev never consults regions.
    await setTaskRegions(prisma, setup.worker.id, taskIdentifier, ["eu-central-1"]);

    const service = createTriggerService(engine, prisma, redisOptions);

    const plain = await service.call({
      taskId: taskIdentifier,
      environment,
      body: { payload: { test: "x" } },
    });
    assertNonNullable(plain);
    expect(plain.run.workerQueue).toBe(environment.id);

    const overridden = await service.call({
      taskId: taskIdentifier,
      environment,
      body: { payload: { test: "y" }, options: { region: "nope" } },
    });
    assertNonNullable(overridden);
    expect(overridden.run.workerQueue).toBe(environment.id);
  });
});
