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
const COMPUTE_QUEUE = "compute-main";
const CONTAINER_QUEUE = "container-main";

function createEngine(
  prisma: PrismaClientOrTransaction,
  redisOptions: any,
  { maxAttempts }: { maxAttempts?: number } = {}
) {
  return new RunEngine({
    prisma: prisma as any,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
      ...(maxAttempts
        ? { retryOptions: { maxAttempts, minTimeoutInMs: 1, maxTimeoutInMs: 1, factor: 1 } }
        : {}),
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

async function trigger(
  engine: RunEngine,
  prisma: PrismaClientOrTransaction,
  environment: MinimalAuthenticatedEnvironment,
  taskIdentifier: string,
  annotations?: { computeOnly?: true; executionMode?: "SANDBOX" }
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
      workerQueue: COMPUTE_QUEUE,
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
      annotations: annotations && {
        triggerSource: "sdk",
        triggerAction: "trigger",
        rootTriggerSource: "sdk",
        ...annotations,
      },
    },
    prisma
  );
  await setTimeout(500);
  return run;
}

/** A fallback that records the worker queues it was asked about. */
function recordingFallback(result: string | undefined) {
  const calls: string[] = [];
  return {
    calls,
    fallback: (queue: string) => {
      calls.push(queue);
      return result;
    },
  };
}

function dequeueCompute(engine: RunEngine, fallback: (queue: string) => string | undefined) {
  return engine.dequeueFromWorkerQueues({
    consumerId: "compute-consumer",
    workerQueues: [{ queue: COMPUTE_QUEUE, weight: 1 }],
    templateFallbackWorkerQueue: fallback,
  });
}

describe("RunEngine dequeue on a worker queue that needs a template", () => {
  containerTest(
    "moves a run without a template to the fallback worker queue",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);
        const run = await trigger(engine, prisma, environment, taskIdentifier);

        const fromCompute = await dequeueCompute(engine, () => CONTAINER_QUEUE);
        expect(fromCompute).toHaveLength(0);

        const moved = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(moved.workerQueue).toBe(CONTAINER_QUEUE);
        expect(moved.lockedToVersionId).toBeNull();

        await setTimeout(500);
        const fromContainer = await engine.dequeueFromWorkerQueue({
          consumerId: "container-consumer",
          workerQueue: CONTAINER_QUEUE,
        });
        expect(fromContainer).toHaveLength(1);
        assertNonNullable(fromContainer[0]);
        expect(fromContainer[0].run.id).toBe(run.id);
        expect(fromContainer[0].run.attemptNumber).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "starts a run whose deployment has a template",
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
        const run = await trigger(engine, prisma, environment, taskIdentifier);

        const { calls, fallback } = recordingFallback(CONTAINER_QUEUE);
        const dequeued = await dequeueCompute(engine, fallback);
        expect(dequeued).toHaveLength(1);
        expect(dequeued[0]?.run.id).toBe(run.id);
        expect(calls).toEqual([]);

        const started = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(started.workerQueue).toBe(COMPUTE_QUEUE);
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: a compute-only or sandbox run moved to a container lane for lack of a template.
  containerTest.for([
    { name: "compute-only", annotations: { computeOnly: true as const } },
    { name: "sandbox", annotations: { executionMode: "SANDBOX" as const } },
  ])(
    "keeps a $name run without a template on compute",
    async ({ annotations }, { prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);
        const run = await trigger(engine, prisma, environment, taskIdentifier, annotations);

        const dequeued = await dequeueCompute(engine, () => CONTAINER_QUEUE);
        expect(dequeued).toHaveLength(0);

        const waiting = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(waiting.workerQueue).toBe(COMPUTE_QUEUE);
        expect(waiting.status).toBe("PENDING");
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: a run that can only start on compute failing, once its template wait runs out, with a
  // message that doesn't say to deploy again.
  containerTest.for([
    {
      name: "compute-only",
      annotations: { computeOnly: true as const },
      message: "This run couldn't start. Deploy again, then replay the run.",
    },
    {
      name: "unpinned",
      annotations: undefined,
      message: "The run's deployment is not ready to start on this worker queue.",
    },
  ])(
    "fails a $name run without a template once its wait budget is spent",
    async ({ annotations, message }, { prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, { maxAttempts: 1 });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);
        const run = await trigger(engine, prisma, environment, taskIdentifier, annotations);

        expect(await dequeueCompute(engine, () => undefined)).toHaveLength(0);

        const failed = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(failed.status).toBe("SYSTEM_FAILURE");
        expect(failed.error).toMatchObject({ code: "TASK_RUN_DEQUEUED_MAX_RETRIES", message });
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "keeps a run on its worker queue when there is no fallback",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);
        const run = await trigger(engine, prisma, environment, taskIdentifier);

        const dequeued = await dequeueCompute(engine, () => undefined);
        expect(dequeued).toHaveLength(0);

        const waiting = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(waiting.workerQueue).toBe(COMPUTE_QUEUE);
        expect(waiting.status).toBe("PENDING");

        // The retry is delayed, so the run is not handed out again straight away.
        await setTimeout(500);
        expect(await dequeueCompute(engine, () => undefined)).toHaveLength(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a consumer without the option starts a run that has no template",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);
        const run = await trigger(engine, prisma, environment, taskIdentifier);

        const dequeued = await engine.dequeueFromWorkerQueues({
          consumerId: "container-consumer",
          workerQueues: [{ queue: COMPUTE_QUEUE, weight: 1 }],
        });
        expect(dequeued).toHaveLength(1);
        expect(dequeued[0]?.run.id).toBe(run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("a restore keeps its worker queue", async ({ prisma, redisOptions }) => {
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
      const run = await trigger(engine, prisma, environment, taskIdentifier);

      const { calls, fallback } = recordingFallback(CONTAINER_QUEUE);
      const [first] = await dequeueCompute(engine, fallback);
      assertNonNullable(first);
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
          reason: "TEMPLATE_FALLBACK_RESTORE",
          location: "location-1",
          imageRef: "image-1",
        },
      });
      expect(checkpoint.ok).toBe(true);

      // The template goes away while the run is suspended.
      await prisma.workerDeployment.update({
        where: { id: deployment.id },
        data: { templateKey: null },
      });

      await engine.completeWaitpoint({ id: waitpoint.waitpoint.id });
      await setTimeout(1000);

      const restored = await dequeueCompute(engine, fallback);
      expect(restored).toHaveLength(1);
      expect(restored[0]?.checkpoint?.location).toBe("location-1");
      expect(calls).toEqual([]);
    } finally {
      await engine.quit();
    }
  });
});
