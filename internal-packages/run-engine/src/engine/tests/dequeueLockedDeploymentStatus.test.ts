import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { type Meter, trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type {
  PrismaClient,
  PrismaClientOrTransaction,
  WorkerDeploymentStatus,
} from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import type { MinimalAuthenticatedEnvironment } from "../../shared/index.js";
import type { ControlPlaneResolver } from "../controlPlaneResolver.js";
import { PassthroughControlPlaneResolver } from "../controlPlaneResolver.js";
import { RunEngine } from "../index.js";
import type { DeploymentStatusMode } from "../types.js";
import { createTestMetricsMeter } from "./helpers/replicaTestHelpers.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const DEPLOYMENT_WAIT_RETRY_MS = 500;

/**
 * A resolver whose worker-version read reports every deployment as still deploying, while
 * `resolveDeploymentStatus` reads the real row. This is the shape of a replica that hasn't caught
 * up with finalize yet, or a cached worker version from before it.
 */
function staleDeployingResolver(prisma: PrismaClient): ControlPlaneResolver {
  const passthrough = new PassthroughControlPlaneResolver({ prisma });

  return {
    resolveEnv: passthrough.resolveEnv.bind(passthrough),
    resolveEnvDeletionState: passthrough.resolveEnvDeletionState.bind(passthrough),
    resolveDeploymentStatus: passthrough.resolveDeploymentStatus.bind(passthrough),
    resolveAuthenticatedEnv: passthrough.resolveAuthenticatedEnv.bind(passthrough),
    resolveWorkerVersion: async (args) => {
      const version = await passthrough.resolveWorkerVersion(args);
      return version?.deployment
        ? { ...version, deployment: { ...version.deployment, status: "DEPLOYING" } }
        : version;
    },
    assertEnvExists: passthrough.assertEnvExists.bind(passthrough),
  };
}

function createEngine(
  prisma: PrismaClientOrTransaction,
  redisOptions: any,
  options: {
    controlPlaneResolver?: ControlPlaneResolver;
    mode?: DeploymentStatusMode;
    meter?: Meter;
  } = {}
) {
  const mode = options.mode ?? "enforce";
  return new RunEngine({
    controlPlaneResolver: options.controlPlaneResolver,
    meter: options.meter,
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
      deploymentWaitRetryMs: DEPLOYMENT_WAIT_RETRY_MS,
      deploymentStatusMode: () => mode,
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

async function triggerLocked(
  engine: RunEngine,
  prisma: PrismaClientOrTransaction,
  environment: MinimalAuthenticatedEnvironment,
  taskIdentifier: string,
  lockedToVersionId: string
) {
  return engine.trigger(
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
      lockedToVersionId,
      isTest: false,
      tags: [],
    },
    prisma
  );
}

async function dequeue(engine: RunEngine, waitMs = 500, environmentId?: string) {
  await setTimeout(waitMs);
  if (environmentId) {
    await engine.runQueue.processMasterQueueForEnvironment(environmentId, 10);
    await setTimeout(200);
  }
  return engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue: "main",
  });
}

async function setupLockedWorker(
  engine: RunEngine,
  prisma: PrismaClientOrTransaction,
  environment: MinimalAuthenticatedEnvironment,
  taskIdentifier: string,
  data: { status: WorkerDeploymentStatus; imageReference?: string | null; builtAt?: Date }
) {
  const { worker, deployment } = await setupBackgroundWorker(engine, environment, taskIdentifier);
  assertNonNullable(deployment);
  await prisma.workerDeployment.update({ where: { id: deployment.id }, data });
  return { worker, deployment };
}

async function expectSystemFailure(engine: RunEngine, runId: string) {
  const executionData = await engine.getRunExecutionData({ runId });
  assertNonNullable(executionData);
  expect(executionData.run.status).toBe("SYSTEM_FAILURE");
  expect(executionData.snapshot.executionStatus).toBe("FINISHED");
}

describe("RunEngine dequeue only starts runs on a DEPLOYED deployment", () => {
  // Catches: a run locked to a failed, timed-out or canceled deployment starting its image.
  for (const status of ["FAILED", "TIMED_OUT", "CANCELED"] as const) {
    containerTest(
      `fails a run locked to a version whose deployment is ${status}`,
      async ({ prisma, redisOptions }) => {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const engine = createEngine(prisma, redisOptions);

        try {
          const taskIdentifier = "test-task";
          const { worker } = await setupLockedWorker(engine, prisma, environment, taskIdentifier, {
            status,
          });

          const run = await triggerLocked(engine, prisma, environment, taskIdentifier, worker.id);

          expect(await dequeue(engine)).toHaveLength(0);
          await expectSystemFailure(engine, run.id);
        } finally {
          await engine.quit();
        }
      }
    );
  }

  // Catches: the missing-image check parking a run on a failed deployment instead of failing it.
  containerTest(
    "fails a run locked to a FAILED deployment that has no image reference",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        const { worker } = await setupLockedWorker(engine, prisma, environment, taskIdentifier, {
          status: "FAILED",
          imageReference: null,
        });

        const run = await triggerLocked(engine, prisma, environment, taskIdentifier, worker.id);

        expect(await dequeue(engine)).toHaveLength(0);
        await expectSystemFailure(engine, run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: a run starting before its deployment finishes, or never starting once it does.
  containerTest(
    "keeps a run locked to a deploying version queued, then starts it once deployed",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        const { worker, deployment } = await setupLockedWorker(
          engine,
          prisma,
          environment,
          taskIdentifier,
          { status: "DEPLOYING" }
        );

        const run = await triggerLocked(engine, prisma, environment, taskIdentifier, worker.id);

        expect(await dequeue(engine)).toHaveLength(0);
        expect(await dequeue(engine, DEPLOYMENT_WAIT_RETRY_MS + 500, environment.id)).toHaveLength(
          0
        );

        const waiting = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(waiting);
        expect(waiting.run.status).toBe("PENDING");
        expect(waiting.snapshot.executionStatus).toBe("QUEUED");

        await prisma.workerDeployment.update({
          where: { id: deployment.id },
          data: { status: "DEPLOYED" },
        });

        const started = await dequeue(engine, DEPLOYMENT_WAIT_RETRY_MS + 500, environment.id);
        expect(started).toHaveLength(1);
        assertNonNullable(started[0]);
        expect(started[0].run.id).toBe(run.id);
        expect(started[0].image).toBe(deployment.imageReference);
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: a waiting run stranded forever when its deployment fails, since nothing wakes it.
  containerTest(
    "fails a waiting run once its deployment fails",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        const { worker, deployment } = await setupLockedWorker(
          engine,
          prisma,
          environment,
          taskIdentifier,
          { status: "DEPLOYING" }
        );

        const run = await triggerLocked(engine, prisma, environment, taskIdentifier, worker.id);

        expect(await dequeue(engine)).toHaveLength(0);

        await prisma.workerDeployment.update({
          where: { id: deployment.id },
          data: { status: "FAILED" },
        });

        expect(await dequeue(engine, DEPLOYMENT_WAIT_RETRY_MS + 500, environment.id)).toHaveLength(
          0
        );
        await expectSystemFailure(engine, run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: a run retrying forever on a deployment whose timeout never fired.
  containerTest(
    "fails a run locked to a deployment stuck deploying past the wait cap",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        const { worker } = await setupLockedWorker(engine, prisma, environment, taskIdentifier, {
          status: "DEPLOYING",
          builtAt: new Date(Date.now() - 20 * 60_000),
        });

        const run = await triggerLocked(engine, prisma, environment, taskIdentifier, worker.id);

        expect(await dequeue(engine)).toHaveLength(0);
        await expectSystemFailure(engine, run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: a stale DEPLOYING read (replica lag, cache) holding a run whose deployment finished.
  containerTest(
    "starts a run whose deployment finished even when the worker-version read is stale",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, {
        controlPlaneResolver: staleDeployingResolver(prisma),
      });

      try {
        const taskIdentifier = "test-task";
        const { worker } = await setupLockedWorker(engine, prisma, environment, taskIdentifier, {
          status: "DEPLOYED",
        });

        const run = await triggerLocked(engine, prisma, environment, taskIdentifier, worker.id);

        const dequeued = await dequeue(engine);
        expect(dequeued).toHaveLength(1);
        assertNonNullable(dequeued[0]);
        expect(dequeued[0].run.id).toBe(run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: the status check holding or failing ordinary runs on a deployed version.
  containerTest("starts a run locked to a DEPLOYED version", async ({ prisma, redisOptions }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const engine = createEngine(prisma, redisOptions);

    try {
      const taskIdentifier = "test-task";
      const { worker } = await setupLockedWorker(engine, prisma, environment, taskIdentifier, {
        status: "DEPLOYED",
      });

      const run = await triggerLocked(engine, prisma, environment, taskIdentifier, worker.id);

      const dequeued = await dequeue(engine);
      expect(dequeued).toHaveLength(1);
      assertNonNullable(dequeued[0]);
      expect(dequeued[0].run.id).toBe(run.id);
    } finally {
      await engine.quit();
    }
  });
});

describe("RunEngine dequeue deployment status in shadow and off modes", () => {
  const METRIC = "run_engine.dequeue.deployment_not_deployed";

  // Catches: shadow mode blocking a run instead of only recording what enforce would do.
  for (const [status, action] of [
    ["FAILED", "fail"],
    ["DEPLOYING", "wait"],
  ] as const) {
    containerTest(
      `shadow mode starts a run locked to a ${status} deployment and counts it as ${action}`,
      async ({ prisma, redisOptions }) => {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { meter, getCounterValue } = createTestMetricsMeter();
        const engine = createEngine(prisma, redisOptions, { mode: "shadow", meter });

        try {
          const taskIdentifier = "test-task";
          const { worker } = await setupLockedWorker(engine, prisma, environment, taskIdentifier, {
            status,
          });

          const run = await triggerLocked(engine, prisma, environment, taskIdentifier, worker.id);

          const dequeued = await dequeue(engine);
          expect(dequeued).toHaveLength(1);
          assertNonNullable(dequeued[0]);
          expect(dequeued[0].run.id).toBe(run.id);

          expect(
            await getCounterValue(METRIC, { mode: "shadow", action, deployment_status: status })
          ).toBe(1);
        } finally {
          await engine.quit();
        }
      }
    );
  }

  // Catches: shadow mode counting a stuck deployment as a plain wait.
  containerTest(
    "shadow mode counts a deployment stuck past the wait cap as fail_stalled",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { meter, getCounterValue } = createTestMetricsMeter();
      const engine = createEngine(prisma, redisOptions, { mode: "shadow", meter });

      try {
        const taskIdentifier = "test-task";
        const { worker } = await setupLockedWorker(engine, prisma, environment, taskIdentifier, {
          status: "DEPLOYING",
          builtAt: new Date(Date.now() - 20 * 60_000),
        });

        await triggerLocked(engine, prisma, environment, taskIdentifier, worker.id);

        expect(await dequeue(engine)).toHaveLength(1);
        expect(await getCounterValue(METRIC, { mode: "shadow", action: "fail_stalled" })).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: the off switch still reading or counting anything, instead of restoring old behaviour.
  containerTest(
    "off mode starts a run locked to a FAILED deployment and records nothing",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { meter, getCounterValue } = createTestMetricsMeter();
      const engine = createEngine(prisma, redisOptions, { mode: "off", meter });

      try {
        const taskIdentifier = "test-task";
        const { worker } = await setupLockedWorker(engine, prisma, environment, taskIdentifier, {
          status: "FAILED",
        });

        await triggerLocked(engine, prisma, environment, taskIdentifier, worker.id);

        expect(await dequeue(engine)).toHaveLength(1);
        expect(await getCounterValue(METRIC)).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );
});
