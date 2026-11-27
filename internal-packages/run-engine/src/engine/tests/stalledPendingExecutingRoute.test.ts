// A stalled PENDING_EXECUTING snapshot must be requeued into a redis-primary run's durable residency. The
// heartbeat payload carries no route, so on an undefined-dial engine the requeue's QUEUED snapshot would
// otherwise take the Postgres shortcut and leave the MemoryDB head at PENDING_EXECUTING. Real infra.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreDial,
} from "@internal/run-store";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import { getLatestExecutionSnapshot } from "../systems/executionSnapshotSystem.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { suspendWithStateHeldCheckpoint } from "./utils/storeRunWaitpointLifecycleFixtures.js";

vi.setConfig({ testTimeout: 90_000 });

const ROUTE = "logical:1";
const PENDING_EXECUTING_TIMEOUT_MS = 500;
const machines = {
  defaultMachine: "small-1x",
  machines: {
    "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
  },
  baseCostInCents: 0.0001,
};

function makeEngine(
  prisma: any,
  redisOptions: any,
  snapshotStore: RedisSnapshotStore,
  dial: () => SnapshotStoreDial | undefined,
  workerEnabled: boolean
) {
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const store = new TaskRunExecutionSnapshotStore(delegate, {
    store: snapshotStore,
    mode: "redis-only",
    resolveDial: dial,
    residencyResolver: new SnapshotResidencyResolver({
      store: snapshotStore,
      taskRunExists: async (id: string) => (await prisma.taskRun.count({ where: { id } })) > 0,
    }),
    resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
    logicalRunStoreRoute: ROUTE,
  });
  return new RunEngine({
    prisma,
    store,
    worker: workerEnabled
      ? { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 }
      : { redis: redisOptions, disabled: true },
    queue: {
      redis: redisOptions,
      retryOptions: { maxTimeoutInMs: 50 },
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines,
    heartbeatTimeoutsMs: { PENDING_EXECUTING: PENDING_EXECUTING_TIMEOUT_MS },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

describe("handleStalledSnapshot honors durable residency for a stalled PENDING_EXECUTING run", () => {
  containerTest(
    "a dial=undefined engine requeues a redis-primary run into its MemoryDB head",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const producer = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-only", false);
      const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined, true);

      try {
        await setupBackgroundWorker(producer, env, "test-task");

        async function dequeueOnConsumer() {
          for (let i = 0; i < 25; i++) {
            await producer.runQueue.processMasterQueueForEnvironment(env.id, 5);
            const dequeued = await consumer.dequeueFromWorkerQueue({
              consumerId: "stall_consumer",
              workerQueue: "main",
            });
            if (dequeued.length > 0) return dequeued[0];
            await setTimeout(300);
          }
          throw new Error("run never reached the worker queue");
        }

        const run = await producer.trigger(
          {
            number: 1,
            friendlyId: "run_stallroute",
            environment: env,
            taskIdentifier: "test-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-stall",
            spanId: "s-stall",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 60_000),
          },
          prisma
        );
        const runId = run.id;

        await prisma.taskRun.update({
          where: { id: runId },
          data: { delayUntil: null, queueTimestamp: new Date() },
        });
        const runRow = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
        await producer.enqueueSystem.enqueueRun({ run: runRow, env, enableFastPath: true });

        const first = await dequeueOnConsumer();
        assertNonNullable(first);
        expect(await snapshotStore.readBirthResidency(runId)).toBe("redis-primary");
        expect(first.snapshot.executionStatus).toBe("PENDING_EXECUTING");

        let latest = await consumer.getRunExecutionData({ runId });
        for (let i = 0; i < 40 && latest?.snapshot.executionStatus !== "QUEUED"; i++) {
          await setTimeout(250);
          latest = await consumer.getRunExecutionData({ runId });
        }
        assertNonNullable(latest);
        expect(latest.snapshot.executionStatus).toBe("QUEUED");
        const head = await snapshotStore.getLatest(runId);
        assertNonNullable(head);
        expect(head.id).toBe(latest.snapshot.id);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        const redelivered = await dequeueOnConsumer();
        assertNonNullable(redelivered);
        expect(redelivered.run.id).toBe(runId);
        expect(redelivered.snapshot.executionStatus).toBe("PENDING_EXECUTING");
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );
});

describe("handleStalledSnapshot keeps a stalled restore's checkpoint", () => {
  // Catches: a stalled PENDING_EXECUTING restore requeued without its checkpoint, so it starts from scratch.
  containerTest(
    "a stalled PENDING_EXECUTING restore of a redis-primary run is requeued with its checkpoint",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const engine = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-only", true);

      try {
        await setupBackgroundWorker(engine, env, "test-task");

        async function dequeue() {
          for (let i = 0; i < 25; i++) {
            await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
            const dequeued = await engine.dequeueFromWorkerQueue({
              consumerId: "stall_restore_consumer",
              workerQueue: "main",
            });
            if (dequeued.length > 0) return dequeued[0];
            await setTimeout(300);
          }
          throw new Error("run never reached the worker queue");
        }

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_stallrestore",
            environment: env,
            taskIdentifier: "test-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-stall-restore",
            spanId: "s-stall-restore",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 60_000),
          },
          prisma
        );
        const runId = run.id;
        await prisma.taskRun.update({
          where: { id: runId },
          data: { delayUntil: null, queueTimestamp: new Date() },
        });
        const runRow = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
        await engine.enqueueSystem.enqueueRun({ run: runRow, env, enableFastPath: true });

        const first = await dequeue();
        assertNonNullable(first);
        await engine.startRunAttempt({ runId, snapshotId: first.snapshot.id });
        expect(await snapshotStore.readBirthResidency(runId)).toBe("redis-primary");
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        const waitpoint = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });
        const blocked = await engine.blockRunWithWaitpoint({
          runId,
          waitpoints: waitpoint.waitpoint.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });
        const suspended = await engine.createCheckpoint({
          runId,
          snapshotId: blocked.id,
          checkpoint: {
            type: "KUBERNETES",
            reason: "TEST_CHECKPOINT",
            location: "test-location",
            imageRef: "test-image-ref",
          },
        });
        if (!suspended.ok) throw new Error(suspended.error);
        const checkpointId = suspended.checkpoint.id;

        await engine.completeWaitpoint({ id: waitpoint.waitpoint.id });
        const restore = await dequeue();
        assertNonNullable(restore);
        expect(restore.snapshot.executionStatus).toBe("PENDING_EXECUTING");
        expect(restore.checkpoint?.id).toBe(checkpointId);

        // Not continued: the PENDING_EXECUTING heartbeat lapses and the run is requeued.
        const deadline = Date.now() + 20_000;
        let latest = await engine.getRunExecutionData({ runId });
        while (latest?.snapshot.executionStatus !== "QUEUED" && Date.now() < deadline) {
          await setTimeout(250);
          latest = await engine.getRunExecutionData({ runId });
        }
        assertNonNullable(latest);
        expect(latest.snapshot.executionStatus).toBe("QUEUED");
        expect(latest.checkpoint?.id).toBe(checkpointId);

        const redelivered = await dequeue();
        assertNonNullable(redelivered);
        expect(redelivered.snapshot.executionStatus).toBe("PENDING_EXECUTING");
        expect(redelivered.checkpoint?.id).toBe(checkpointId);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  // Catches: a stalled PENDING_EXECUTING restore requeued without its state-held checkpoint's record.
  containerTest(
    "a stalled PENDING_EXECUTING restore of a state-held checkpoint is requeued with it",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const engine = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-only", true);

      try {
        await setupBackgroundWorker(engine, env, "test-task");

        async function dequeue() {
          for (let i = 0; i < 25; i++) {
            await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
            const dequeued = await engine.dequeueFromWorkerQueue({
              consumerId: "stall_restore_consumer",
              workerQueue: "main",
            });
            if (dequeued.length > 0) return dequeued[0];
            await setTimeout(300);
          }
          throw new Error("run never reached the worker queue");
        }

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_stallrestore",
            environment: env,
            taskIdentifier: "test-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-stall-restore",
            spanId: "s-stall-restore",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 60_000),
          },
          prisma
        );
        const runId = run.id;
        await prisma.taskRun.update({
          where: { id: runId },
          data: { delayUntil: null, queueTimestamp: new Date() },
        });
        const runRow = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
        await engine.enqueueSystem.enqueueRun({ run: runRow, env, enableFastPath: true });

        const first = await dequeue();
        assertNonNullable(first);
        await engine.startRunAttempt({ runId, snapshotId: first.snapshot.id });
        expect(await snapshotStore.readBirthResidency(runId)).toBe("redis-primary");
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        const waitpoint = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });
        const blocked = await engine.blockRunWithWaitpoint({
          runId,
          waitpoints: waitpoint.waitpoint.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });
        const { checkpoint } = await suspendWithStateHeldCheckpoint(
          engine,
          prisma,
          runId,
          blocked.id,
          {
            type: "KUBERNETES",
            location: "test-location",
            imageRef: "test-image-ref",
            reason: "TEST_CHECKPOINT",
          }
        );
        const checkpointId = checkpoint.id;

        await engine.completeWaitpoint({ id: waitpoint.waitpoint.id });
        const restore = await dequeue();
        assertNonNullable(restore);
        expect(restore.snapshot.executionStatus).toBe("PENDING_EXECUTING");
        expect(restore.checkpoint?.id).toBe(checkpointId);

        // Not continued: the PENDING_EXECUTING heartbeat lapses and the run is requeued.
        const deadline = Date.now() + 20_000;
        let latest = await getLatestExecutionSnapshot(prisma, runId, engine.runStore);
        while (latest.executionStatus !== "QUEUED" && Date.now() < deadline) {
          await setTimeout(250);
          latest = await getLatestExecutionSnapshot(prisma, runId, engine.runStore);
        }
        expect(latest.executionStatus).toBe("QUEUED");
        expect(latest.checkpointStore).toBe("state");
        expect(latest.checkpoint?.id).toBe(checkpointId);
        expect(latest.checkpoint?.location).toBe("test-location");

        const redelivered = await dequeue();
        assertNonNullable(redelivered);
        expect(redelivered.snapshot.executionStatus).toBe("PENDING_EXECUTING");
        expect(redelivered.checkpoint?.id).toBe(checkpointId);
        expect(await prisma.taskRunCheckpoint.count({ where: { id: checkpointId } })).toBe(0);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});
