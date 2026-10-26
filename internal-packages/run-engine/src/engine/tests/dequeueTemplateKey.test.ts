import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { expect } from "vitest";
import { setTimeout } from "node:timers/promises";
import type { MinimalAuthenticatedEnvironment } from "../../shared/index.js";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const TEMPLATE_KEY = "4f2b1c0e9d8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c";

function createEngine(prisma: PrismaClientOrTransaction, redisOptions: any) {
  return new RunEngine({
    prisma: prisma as any,
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

async function triggerAndDequeue(
  engine: RunEngine,
  prisma: PrismaClientOrTransaction,
  environment: MinimalAuthenticatedEnvironment,
  taskIdentifier: string
) {
  const run = await engine.trigger(
    {
      number: 1,
      friendlyId: generateFriendlyId("run"),
      environment,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );

  await setTimeout(500);

  const dequeued = await engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue: "main",
  });
  expect(dequeued.length).toBe(1);
  assertNonNullable(dequeued[0]);
  return { run, message: dequeued[0] };
}

describe("RunEngine dequeue carries the deployment's template key", () => {
  containerTest("omits it when the deployment has none", async ({ prisma, redisOptions }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const engine = createEngine(prisma, redisOptions);

    try {
      const taskIdentifier = "test-task";
      const { deployment } = await setupBackgroundWorker(engine, environment, taskIdentifier);
      assertNonNullable(deployment);

      const { message } = await triggerAndDequeue(engine, prisma, environment, taskIdentifier);

      expect(message.image).toBe(deployment.imageReference);
      expect(message.templateKey).toBeUndefined();
    } finally {
      await engine.quit();
    }
  });

  containerTest(
    "sends it next to the image when the deployment has one",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        const { deployment } = await setupBackgroundWorker(engine, environment, taskIdentifier);
        assertNonNullable(deployment);
        await prisma.workerDeployment.update({
          where: { id: deployment.id },
          data: { templateKey: TEMPLATE_KEY },
        });

        const { message } = await triggerAndDequeue(engine, prisma, environment, taskIdentifier);

        expect(message.image).toBe(deployment.imageReference);
        expect(message.templateKey).toBe(TEMPLATE_KEY);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("sends it with a restore from a checkpoint", async ({ prisma, redisOptions }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const engine = createEngine(prisma, redisOptions);

    try {
      const taskIdentifier = "test-task";
      const { deployment } = await setupBackgroundWorker(engine, environment, taskIdentifier);
      assertNonNullable(deployment);
      await prisma.workerDeployment.update({
        where: { id: deployment.id },
        data: { templateKey: TEMPLATE_KEY },
      });

      const { run, message: first } = await triggerAndDequeue(
        engine,
        prisma,
        environment,
        taskIdentifier
      );

      await engine.startRunAttempt({ runId: first.run.id, snapshotId: first.snapshot.id });

      const waitpoint = await engine.createManualWaitpoint({
        environmentId: environment.id,
        projectId: environment.projectId,
      });
      const blocked = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: waitpoint.waitpoint.id,
        projectId: environment.projectId,
        organizationId: environment.organizationId,
      });

      const checkpoint = await engine.createCheckpoint({
        runId: run.id,
        snapshotId: blocked.id,
        checkpoint: {
          type: "DOCKER",
          reason: "TEMPLATE_KEY_RESTORE",
          location: "location-1",
          imageRef: "image-1",
        },
      });
      expect(checkpoint.ok).toBe(true);

      await engine.completeWaitpoint({ id: waitpoint.waitpoint.id });
      await setTimeout(1000);

      const restored = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      expect(restored.length).toBe(1);
      assertNonNullable(restored[0]);

      expect(restored[0].checkpoint?.location).toBe("location-1");
      expect(restored[0].image).toBe(deployment.imageReference);
      expect(restored[0].templateKey).toBe(TEMPLATE_KEY);
    } finally {
      await engine.quit();
    }
  });
});
