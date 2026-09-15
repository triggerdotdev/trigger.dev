import { describe, expect, onTestFinished, vi } from "vitest";

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
import { setTimeout } from "node:timers/promises";
import type { PrismaClient, PrismaReplicaClient } from "@trigger.dev/database";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { RunEngineControlPlaneResolver } from "~/v3/runOpsMigration/runEngineControlPlaneResolver.server";
import {
  MockPayloadProcessor,
  MockTraceEventConcern,
  MockTriggerTaskValidator,
} from "./triggerTaskTestHelpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function buildEngine(prisma: PrismaClient, redisOptions: any) {
  const appResolver = new ControlPlaneResolver({
    controlPlanePrimary: prisma,
    controlPlaneReplica: prisma as unknown as PrismaReplicaClient,
    cache: new ControlPlaneCache(),
    splitEnabled: () => true,
    workerVersionFreshReadEnabled: () => true,
  });

  return new RunEngine({
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
    controlPlaneResolver: new RunEngineControlPlaneResolver(appResolver),
  });
}

function buildTriggerService(engine: RunEngine, prisma: PrismaClient) {
  return new RunEngineTriggerTaskService({
    engine,
    prisma,
    payloadProcessor: new MockPayloadProcessor(),
    queueConcern: new DefaultQueueManager(prisma, engine),
    idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
    validator: new MockTriggerTaskValidator(),
    traceEventConcern: new MockTraceEventConcern(),
    tracer: trace.getTracer("test", "0.0.0"),
    metadataMaximumSize: 1024 * 1024 * 1,
  });
}

describe("Dequeue worker-version dispatch freshness end-to-end (TRI-13291)", () => {
  containerTest(
    "a run triggered after a mid-stream promotion dequeues onto the NEWLY-promoted version",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma as unknown as PrismaClient, redisOptions);
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "fresh-task";

      const v1 = await setupBackgroundWorker(engine, environment, taskIdentifier);
      const triggerService = buildTriggerService(engine, prisma as unknown as PrismaClient);

      const run1 = await triggerService.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { n: 1 } },
      });
      assertNonNullable(run1);

      await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
      await setTimeout(500);

      const run1Row = await prisma.taskRun.findUniqueOrThrow({ where: { id: run1.run.id } });
      const dequeued1 = await engine.dequeueFromWorkerQueue({
        consumerId: "c1",
        workerQueue: run1Row.workerQueue!,
      });
      expect(dequeued1.length).toBe(1);
      assertNonNullable(dequeued1[0]);
      expect(dequeued1[0].run.id).toBe(run1.run.id);
      expect(dequeued1[0].backgroundWorker.id).toBe(v1.worker.id);
      expect(dequeued1[0].backgroundWorker.version).toBe(v1.worker.version);

      const v2 = await setupBackgroundWorker(engine, environment, taskIdentifier);
      expect(v2.worker.id).not.toBe(v1.worker.id);
      expect(v2.worker.version).not.toBe(v1.worker.version);

      const currentPromotion = await prisma.workerDeploymentPromotion.findFirstOrThrow({
        where: { environmentId: environment.id, label: "current" },
        include: { deployment: true },
      });
      expect(currentPromotion.deployment.workerId).toBe(v2.worker.id);

      const run2 = await triggerService.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { n: 2 } },
      });
      assertNonNullable(run2);

      await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
      await setTimeout(500);

      const run2Row = await prisma.taskRun.findUniqueOrThrow({ where: { id: run2.run.id } });
      const dequeued2 = await engine.dequeueFromWorkerQueue({
        consumerId: "c2",
        workerQueue: run2Row.workerQueue!,
      });
      expect(dequeued2.length).toBe(1);
      assertNonNullable(dequeued2[0]);
      expect(dequeued2[0].run.id).toBe(run2.run.id);

      expect(dequeued2[0].backgroundWorker.id).toBe(v2.worker.id);
      expect(dequeued2[0].backgroundWorker.version).toBe(v2.worker.version);
      expect(dequeued2[0].deployment.id).toBe(v2.deployment.id);
      expect(dequeued2[0].image).toContain(v2.worker.version);
    }
  );
});
