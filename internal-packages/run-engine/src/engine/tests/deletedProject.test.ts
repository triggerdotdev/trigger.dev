import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import type { ControlPlaneResolver } from "../controlPlaneResolver.js";
import { PassthroughControlPlaneResolver } from "../controlPlaneResolver.js";
import { RunEngine } from "../index.js";
import { createTestSnapshot } from "./helpers/snapshotTestHelpers.js";
import type { AuthenticatedEnvironment } from "./setup.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const DELAY_MS = 5_000;

/**
 * A resolver whose `resolveEnv` reports the environment as live even after deletion, while
 * `resolveEnvDeletionState` tells the truth. This is the shape of the real cloud resolver
 * between a delete in one process and the cache entry expiring in another: `resolveEnv` is
 * cache-fronted and its invalidation is process-local. The database underneath is real.
 */
function staleEnvCacheResolver(prisma: PrismaClient): ControlPlaneResolver {
  const passthrough = new PassthroughControlPlaneResolver({ prisma });

  return {
    resolveEnv: async (environmentId: string) => {
      const env = await passthrough.resolveEnv(environmentId);
      return env ? { ...env, projectDeletedAt: null, organizationDeletedAt: null } : null;
    },
    resolveEnvDeletionState: passthrough.resolveEnvDeletionState.bind(passthrough),
    resolveAuthenticatedEnv: passthrough.resolveAuthenticatedEnv.bind(passthrough),
    resolveWorkerVersion: passthrough.resolveWorkerVersion.bind(passthrough),
    assertEnvExists: passthrough.assertEnvExists.bind(passthrough),
  };
}

/**
 * A resolver that reports the environment as live and present, but whose authoritative deletion
 * read finds no environment row at all. Models the control-plane row having gone while a cache
 * still serves it.
 */
function missingEnvironmentResolver(prisma: PrismaClient): ControlPlaneResolver {
  const passthrough = new PassthroughControlPlaneResolver({ prisma });

  return {
    resolveEnv: passthrough.resolveEnv.bind(passthrough),
    resolveEnvDeletionState: async () => null,
    resolveAuthenticatedEnv: passthrough.resolveAuthenticatedEnv.bind(passthrough),
    resolveWorkerVersion: passthrough.resolveWorkerVersion.bind(passthrough),
    assertEnvExists: passthrough.assertEnvExists.bind(passthrough),
  };
}

function createEngine(
  redisOptions: any,
  prisma: PrismaClient,
  controlPlaneResolver?: ControlPlaneResolver
) {
  return new RunEngine({
    prisma,
    controlPlaneResolver,
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
}

async function triggerRun(
  engine: RunEngine,
  environment: AuthenticatedEnvironment,
  taskIdentifier: string,
  prisma: PrismaClient,
  delayUntil?: Date
) {
  const friendlyId = generateFriendlyId("run");

  return engine.trigger(
    {
      number: 1,
      friendlyId,
      environment,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: friendlyId,
      spanId: friendlyId,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
      delayUntil,
    },
    prisma
  );
}

/** Polls until the run is FINISHED, so the tests do not depend on a fixed settling time. */
async function waitForFinished(engine: RunEngine, runId: string, deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs;

  while (Date.now() < deadline) {
    const data = await engine.getRunExecutionData({ runId });

    if (data?.snapshot.executionStatus === "FINISHED") {
      return data;
    }

    await setTimeout(200);
  }

  return engine.getRunExecutionData({ runId });
}

describe("RunEngine deleted project", () => {
  containerTest(
    "a delayed run whose project was deleted is cancelled instead of enqueued",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(redisOptions, prisma);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await triggerRun(
          engine,
          environment,
          taskIdentifier,
          prisma,
          new Date(Date.now() + DELAY_MS)
        );

        const delayed = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(delayed);
        expect(delayed.snapshot.executionStatus).toBe("DELAYED");

        await prisma.project.update({
          where: { id: environment.projectId },
          data: { deletedAt: new Date() },
        });

        const after = await waitForFinished(engine, run.id);
        assertNonNullable(after);
        expect(after.snapshot.executionStatus).toBe("FINISHED");
        expect(after.run.status).toBe("CANCELED");

        expect(await engine.lengthOfEnvQueue(environment)).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a delayed run whose organization was deleted is cancelled instead of enqueued",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(redisOptions, prisma);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await triggerRun(
          engine,
          environment,
          taskIdentifier,
          prisma,
          new Date(Date.now() + DELAY_MS)
        );

        const delayed = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(delayed);
        expect(delayed.snapshot.executionStatus).toBe("DELAYED");

        await prisma.organization.update({
          where: { id: environment.organizationId },
          data: { deletedAt: new Date() },
        });

        const after = await waitForFinished(engine, run.id);
        assertNonNullable(after);
        expect(after.snapshot.executionStatus).toBe("FINISHED");
        expect(after.run.status).toBe("CANCELED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a delayed run is cancelled even while the resolved env still reports the project as live",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(redisOptions, prisma, staleEnvCacheResolver(prisma));

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await triggerRun(
          engine,
          environment,
          taskIdentifier,
          prisma,
          new Date(Date.now() + DELAY_MS)
        );

        await prisma.project.update({
          where: { id: environment.projectId },
          data: { deletedAt: new Date() },
        });

        expect(
          (await engine.controlPlaneResolver.resolveEnv(environment.id))!.projectDeletedAt
        ).toBeNull();

        const after = await waitForFinished(engine, run.id);
        assertNonNullable(after);
        expect(after.snapshot.executionStatus).toBe("FINISHED");
        expect(after.run.status).toBe("CANCELED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a delayed run on a live project is still enqueued",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(redisOptions, prisma);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await triggerRun(
          engine,
          environment,
          taskIdentifier,
          prisma,
          new Date(Date.now() + 500)
        );

        await setTimeout(2_000);

        const after = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(after);
        expect(after.snapshot.executionStatus).toBe("QUEUED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "an already-queued run is cancelled at dequeue once the project is deleted",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(redisOptions, prisma);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await triggerRun(engine, environment, taskIdentifier, prisma);

        const queued = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(queued);
        expect(queued.snapshot.executionStatus).toBe("QUEUED");

        await prisma.project.update({
          where: { id: environment.projectId },
          data: { deletedAt: new Date() },
        });

        await engine.runQueue.processMasterQueueForEnvironment(environment.id, 5);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
          blockingPop: false,
        });

        expect(dequeued.length).toBe(0);
        expect(
          await engine.runQueue.readMessage(environment.organizationId, run.id)
        ).toBeUndefined();

        const after = await waitForFinished(engine, run.id);
        assertNonNullable(after);
        expect(after.snapshot.executionStatus).toBe("FINISHED");
        expect(after.run.status).toBe("CANCELED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "an already-queued run is cancelled at dequeue once the organization is deleted",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(redisOptions, prisma);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await triggerRun(engine, environment, taskIdentifier, prisma);

        await prisma.organization.update({
          where: { id: environment.organizationId },
          data: { deletedAt: new Date() },
        });

        await engine.runQueue.processMasterQueueForEnvironment(environment.id, 5);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
          blockingPop: false,
        });

        expect(dequeued.length).toBe(0);

        const after = await waitForFinished(engine, run.id);
        assertNonNullable(after);
        expect(after.snapshot.executionStatus).toBe("FINISHED");
        expect(after.run.status).toBe("CANCELED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a delayed run is cancelled when the environment row itself is gone",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(redisOptions, prisma, missingEnvironmentResolver(prisma));

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await triggerRun(
          engine,
          environment,
          taskIdentifier,
          prisma,
          new Date(Date.now() + DELAY_MS)
        );

        const after = await waitForFinished(engine, run.id);
        assertNonNullable(after);
        expect(after.snapshot.executionStatus).toBe("FINISHED");
        expect(after.run.status).toBe("CANCELED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a QUEUED_EXECUTING run is not resumed once the project is deleted",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(redisOptions, prisma);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await triggerRun(engine, environment, taskIdentifier, prisma);

        const queued = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(queued);

        await createTestSnapshot(prisma, {
          runId: run.id,
          status: "QUEUED_EXECUTING",
          environmentId: environment.id,
          environmentType: "PRODUCTION",
          projectId: environment.projectId,
          organizationId: environment.organizationId,
          previousSnapshotId: queued.snapshot.id,
          attemptNumber: 1,
        });

        const resumable = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(resumable);
        expect(resumable.snapshot.executionStatus).toBe("QUEUED_EXECUTING");

        await prisma.project.update({
          where: { id: environment.projectId },
          data: { deletedAt: new Date() },
        });

        await engine.runQueue.processMasterQueueForEnvironment(environment.id, 5);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
          blockingPop: false,
        });

        expect(dequeued.length).toBe(0);

        const after = await waitForFinished(engine, run.id);
        assertNonNullable(after);
        expect(after.snapshot.executionStatus).toBe("FINISHED");
        expect(after.run.status).toBe("CANCELED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a QUEUED_EXECUTING run on a live project is still resumed",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(redisOptions, prisma);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await triggerRun(engine, environment, taskIdentifier, prisma);

        const queued = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(queued);

        await createTestSnapshot(prisma, {
          runId: run.id,
          status: "QUEUED_EXECUTING",
          environmentId: environment.id,
          environmentType: "PRODUCTION",
          projectId: environment.projectId,
          organizationId: environment.organizationId,
          previousSnapshotId: queued.snapshot.id,
          attemptNumber: 1,
        });

        await engine.runQueue.processMasterQueueForEnvironment(environment.id, 5);
        await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
          blockingPop: false,
        });

        const after = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(after);
        expect(after.snapshot.executionStatus).toBe("EXECUTING");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a queued run on a live project still dequeues",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(redisOptions, prisma);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        await triggerRun(engine, environment, taskIdentifier, prisma);

        await engine.runQueue.processMasterQueueForEnvironment(environment.id, 5);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
          blockingPop: false,
        });

        expect(dequeued.length).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );
});
