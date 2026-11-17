import {
  assertNonNullable,
  containerTest,
  containerTestWithIsolatedRedis,
  laggingReplica,
} from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { MinimalAuthenticatedEnvironment } from "../../shared/index.js";
import type { ControlPlaneResolver } from "../controlPlaneResolver.js";
import { PassthroughControlPlaneResolver } from "../controlPlaneResolver.js";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import type { DequeuedMessage } from "@trigger.dev/core/v3";
import { PostgresPendingVersionRunIdLookup } from "./postgresPendingVersionLookup.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine pending version", () => {
  containerTest(
    "When a run is triggered but the background task hasn't been created yet",
    async ({ prisma, redisOptions }) => {
      //create environment
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
          processWorkerQueueDebounceMs: 50,
          masterQueueConsumersDisabled: true,
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
          baseCostInCents: 0.0001,
        },
        //set this so we have to requeue the runs in two batches
        queueRunsWaitingForWorkerBatchSize: 1,
        pendingVersionRunIdLookup: new PostgresPendingVersionRunIdLookup(prisma),
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        //trigger the run
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        //trigger another run
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_1235",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        //should be queued
        const executionDataR1 = await engine.getRunExecutionData({ runId: run.id });
        const executionDataR2 = await engine.getRunExecutionData({ runId: run2.id });
        assertNonNullable(executionDataR1);
        assertNonNullable(executionDataR2);
        expect(executionDataR1.snapshot.executionStatus).toBe("QUEUED");
        expect(executionDataR2.snapshot.executionStatus).toBe("QUEUED");

        await setupBackgroundWorker(engine, authenticatedEnvironment, ["test-task-other"]);

        await setTimeout(500);

        const dequeued: DequeuedMessage[] = [];
        for (let i = 0; i < 2; i++) {
          dequeued.push(
            ...(await engine.dequeueFromWorkerQueue({
              consumerId: "test_12345",
              workerQueue: "main",
            }))
          );
        }
        expect(dequeued.length).toBe(0);

        //queue should be empty
        const queueLength = await engine.runQueue.lengthOfQueue(
          authenticatedEnvironment,
          run.queue
        );
        expect(queueLength).toBe(0);

        //check the execution data now
        const executionData2R1 = await engine.getRunExecutionData({ runId: run.id });
        const executionData2R2 = await engine.getRunExecutionData({ runId: run2.id });
        assertNonNullable(executionData2R1);
        assertNonNullable(executionData2R2);
        expect(executionData2R1.snapshot.executionStatus).toBe("RUN_CREATED");
        expect(executionData2R2.snapshot.executionStatus).toBe("RUN_CREATED");
        expect(executionData2R1.run.status).toBe("PENDING_VERSION");
        expect(executionData2R2.run.status).toBe("PENDING_VERSION");

        //create background worker
        const _backgroundWorker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier
        );

        //it's async so we wait
        await setTimeout(1000);

        //should now be queued
        const executionData3R1 = await engine.getRunExecutionData({ runId: run.id });
        const executionData3R2 = await engine.getRunExecutionData({ runId: run2.id });
        assertNonNullable(executionData3R1);
        assertNonNullable(executionData3R2);
        expect(executionData3R1.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData3R2.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData3R1.run.status).toBe("PENDING");
        expect(executionData3R2.run.status).toBe("PENDING");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "When a run is triggered but the queue hasn't been created yet",
    async ({ prisma, redisOptions }) => {
      //create environment
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
          processWorkerQueueDebounceMs: 50,
          masterQueueConsumersDisabled: true,
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
          baseCostInCents: 0.0001,
        },
        //set this so we have to requeue the runs in two batches
        queueRunsWaitingForWorkerBatchSize: 1,
        pendingVersionRunIdLookup: new PostgresPendingVersionRunIdLookup(prisma),
        tracer: trace.getTracer("test", "0.0.0"),
        logLevel: "debug",
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        //trigger the run
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            queue: "custom-queue",
            isTest: false,
            tags: [],
          },
          prisma
        );

        //trigger another run
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_1235",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            queue: "custom-queue-2",
            isTest: false,
            tags: [],
          },
          prisma
        );

        //should be queued
        const executionDataR1 = await engine.getRunExecutionData({ runId: run.id });
        const executionDataR2 = await engine.getRunExecutionData({ runId: run2.id });
        assertNonNullable(executionDataR1);
        assertNonNullable(executionDataR2);
        expect(executionDataR1.snapshot.executionStatus).toBe("QUEUED");
        expect(executionDataR2.snapshot.executionStatus).toBe("QUEUED");

        await engine.runQueue.processMasterQueueForEnvironment(authenticatedEnvironment.id);

        //dequeuing should fail
        const dequeued = await engine.dequeueFromWorkerQueue({
          blockingPopTimeoutSeconds: 1,
          consumerId: "test_12345",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(0);

        const dequeued2 = await engine.dequeueFromWorkerQueue({
          blockingPopTimeoutSeconds: 1,
          consumerId: "test_12345",
          workerQueue: "main",
        });
        expect(dequeued2.length).toBe(0);

        //queue should be empty
        const queueLength = await engine.runQueue.lengthOfQueue(
          authenticatedEnvironment,
          run.queue
        );
        expect(queueLength).toBe(0);

        //check the execution data now
        const executionData2R1 = await engine.getRunExecutionData({ runId: run.id });
        const executionData2R2 = await engine.getRunExecutionData({ runId: run2.id });
        assertNonNullable(executionData2R1);
        assertNonNullable(executionData2R2);
        expect(executionData2R1.snapshot.executionStatus).toBe("RUN_CREATED");
        expect(executionData2R2.snapshot.executionStatus).toBe("RUN_CREATED");
        expect(executionData2R1.run.status).toBe("PENDING_VERSION");
        expect(executionData2R2.run.status).toBe("PENDING_VERSION");

        //create background worker
        const _backgroundWorker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier,
          undefined,
          undefined,
          {
            customQueues: ["custom-queue", "custom-queue-2"],
          }
        );

        //it's async so we wait
        await setTimeout(1000);

        //should now be queued
        const executionData3R1 = await engine.getRunExecutionData({ runId: run.id });
        const executionData3R2 = await engine.getRunExecutionData({ runId: run2.id });
        assertNonNullable(executionData3R1);
        assertNonNullable(executionData3R2);
        expect(executionData3R1.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData3R2.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData3R1.run.status).toBe("PENDING");
        expect(executionData3R2.run.status).toBe("PENDING");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "PENDING_VERSION re-enqueue arms TTL but anchors the scheduling-delay clock at the promotion",
    async ({ prisma, redisOptions }) => {
      // When a run enters PENDING_VERSION (background worker doesn't yet have
      // the task), the first enqueue happens but the message is dequeued and
      // its TTL set entry is dropped while the run waits for a matching worker.
      // Once a worker arrives, pendingVersionSystem re-enqueues. That
      // re-enqueue is the first time the run is actually queued for a worker,
      // so TTL must be armed at that point — not held over from the original
      // enqueue.
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
          processWorkerQueueDebounceMs: 50,
          masterQueueConsumersDisabled: true,
          ttlSystem: {
            pollIntervalMs: 100,
            batchSize: 10,
            batchMaxWaitMs: 100,
          },
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
          baseCostInCents: 0.0001,
        },
        pendingVersionRunIdLookup: new PostgresPendingVersionRunIdLookup(prisma),
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        // Trigger a run with TTL — no background worker exists yet for this
        // task, so it will end up in PENDING_VERSION.
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_pvttl1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "tpv1",
            spanId: "spv1",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            ttl: "10m",
          },
          prisma
        );

        // A worker arrives that doesn't have this task — flushes the run to
        // PENDING_VERSION.
        await setupBackgroundWorker(engine, authenticatedEnvironment, ["test-task-other"]);

        await setTimeout(500);

        // The consumer attempt is what flushes the run to PENDING_VERSION —
        // dequeue finds no matching task version and returns nothing.
        const dequeuedEmpty = await engine.dequeueFromWorkerQueue({
          blockingPopTimeoutSeconds: 1,
          consumerId: "test_pv",
          workerQueue: "main",
        });
        expect(dequeuedEmpty.length).toBe(0);

        const executionDataAfter = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionDataAfter);
        expect(executionDataAfter.run.status).toBe("PENDING_VERSION");

        // Now a worker arrives WITH the task — pendingVersionSystem
        // re-enqueues the run.
        const beforePromotion = Date.now();
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        await setTimeout(1000);

        const executionDataReenqueued = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionDataReenqueued);
        expect(executionDataReenqueued.run.status).toBe("PENDING");

        // The re-enqueued message must carry ttlExpiresAt so the TTL set
        // tracks it for expiration.
        const message = await engine.runQueue.readMessage(
          authenticatedEnvironment.organization.id,
          run.id
        );
        assertNonNullable(message);
        expect(message.ttlExpiresAt).toBeDefined();
        expect(typeof message.ttlExpiresAt).toBe("number");

        const queuePositionMs = (run.queueTimestamp ?? run.createdAt).getTime();

        expect(
          message.eligibleAtMs,
          "scheduling-delay clock must start at the promotion, since the run was not runnable while it waited for a worker version"
        ).toBeGreaterThanOrEqual(beforePromotion);
        expect(
          message.eligibleAtMs,
          "anchoring at the original queue position would bill the whole wait-for-deploy period as queue scheduling delay"
        ).toBeGreaterThan(queuePositionMs);
        expect(
          message.timestamp,
          "ordering keeps the original queue position, so waiting for a deployment must not cost the run its place in line"
        ).toBe(queuePositionMs - run.priorityMs);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "confirms a replica miss on the primary instead of parking the run",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      // The replica sees the new promotion but not yet the deployment's worker: a state the
      // primary never had, which a reader behind its peers can serve.
      const frozenPromotions: Record<string, unknown>[] = [];
      const replica = laggingReplica(prisma, [
        { model: "workerDeploymentPromotion", mode: "frozen", rows: frozenPromotions },
      ]);
      const engine = createEngine(
        prisma,
        redisOptions,
        replicaResolver(prisma, replica.client as PrismaClient)
      );

      try {
        const { deployment, promotion } = await setupBackgroundWorker(
          engine,
          environment,
          "test-task"
        );
        assertNonNullable(deployment);
        assertNonNullable(promotion);
        frozenPromotions.push({ ...promotion, deployment: { ...deployment, worker: null } });

        const run = await triggerRun(engine, prisma, environment, "test-task");

        const dequeued = await dequeueUntil(engine, environment);

        expect(replica.wasHit("workerDeploymentPromotion")).toBe(true);
        expect(dequeued.map((d) => d.run.id)).toEqual([run.id]);
        const runRow = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(runRow.status).not.toBe("PENDING_VERSION");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "requeues a run parked after its deployment's pending-version sweep",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const passthrough = new PassthroughControlPlaneResolver({ prisma });
      // Both the replica read and the primary confirm miss the worker, as when the deploy is
      // promoted between the confirm and the park. Later primary reads see it.
      let primaryReads = 0;
      let replicaCaughtUp = false;
      const resolver: ControlPlaneResolver = {
        ...bindPassthrough(passthrough),
        resolveWorkerVersion: async (args) =>
          replicaCaughtUp ? passthrough.resolveWorkerVersion(args) : null,
        resolveWorkerVersionFromPrimary: async (args) =>
          ++primaryReads === 1 ? null : passthrough.resolveWorkerVersionFromPrimary(args),
      };
      // The default lookup finds nothing, so only the re-check after parking can requeue the run.
      const engine = createEngine(prisma, redisOptions, resolver);

      try {
        await setupBackgroundWorker(engine, environment, "test-task");
        const run = await triggerRun(engine, prisma, environment, "test-task");

        await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
        const firstDequeue = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
          blockingPopTimeoutSeconds: 1,
        });
        expect(firstDequeue).toHaveLength(0);
        expect(primaryReads).toBeGreaterThanOrEqual(2);

        // The parked run is promoted back to PENDING by the scheduled job, then dequeues.
        replicaCaughtUp = true;
        const dequeued = await dequeueUntil(engine, environment);

        expect(dequeued.map((d) => d.run.id)).toEqual([run.id]);
      } finally {
        await engine.quit();
      }
    }
  );
});

function bindPassthrough(passthrough: PassthroughControlPlaneResolver): ControlPlaneResolver {
  return {
    resolveEnv: passthrough.resolveEnv.bind(passthrough),
    resolveEnvDeletionState: passthrough.resolveEnvDeletionState.bind(passthrough),
    resolveDeploymentStatus: passthrough.resolveDeploymentStatus.bind(passthrough),
    resolveAuthenticatedEnv: passthrough.resolveAuthenticatedEnv.bind(passthrough),
    resolveWorkerVersion: passthrough.resolveWorkerVersion.bind(passthrough),
    resolveWorkerVersionFromPrimary: passthrough.resolveWorkerVersionFromPrimary.bind(passthrough),
    assertEnvExists: passthrough.assertEnvExists.bind(passthrough),
  };
}

/** Primary reads go to `prisma`; the worker-version read goes to the lagging `replica`. */
function replicaResolver(prisma: PrismaClient, replica: PrismaClient): ControlPlaneResolver {
  const fromReplica = new PassthroughControlPlaneResolver({ prisma: replica });
  return {
    ...bindPassthrough(new PassthroughControlPlaneResolver({ prisma })),
    resolveWorkerVersion: fromReplica.resolveWorkerVersion.bind(fromReplica),
  };
}

function createEngine(
  prisma: PrismaClient,
  redisOptions: any,
  controlPlaneResolver: ControlPlaneResolver
) {
  return new RunEngine({
    prisma,
    controlPlaneResolver,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      processWorkerQueueDebounceMs: 50,
      masterQueueConsumersDisabled: true,
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
  prisma: PrismaClient,
  environment: MinimalAuthenticatedEnvironment,
  taskIdentifier: string
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
      isTest: false,
      tags: [],
    },
    prisma
  );
}

async function dequeueUntil(engine: RunEngine, environment: MinimalAuthenticatedEnvironment) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_12345",
      workerQueue: "main",
      blockingPopTimeoutSeconds: 1,
    });
    if (dequeued.length > 0) {
      return dequeued;
    }
  }
  throw new Error("the run was never dequeued");
}
