// reportRestoreOutcome must honor a redis-primary run's durable residency when the report carries no
// route. A PRODUCER (dial=redis-only) births the run redis-primary; an undefined-dial CONSUMER takes the
// route-less report. Without the durable fallback the consumer's transition takes the Postgres shortcut
// and the MemoryDB head stays PENDING_EXECUTING. Real infra, no mocks.
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
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 90_000 });

const ROUTE = "logical:1";
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
  extra?: Record<string, unknown>
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
    worker: { redis: redisOptions, disabled: true, ...(extra?.worker as object) },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines,
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

describe("reportRestoreOutcome honors durable residency when the report carries no route", () => {
  for (const outcome of ["requeue", "fail"] as const) {
    containerTest(
      `a route-less ${outcome} on a dial=undefined engine advances a redis-primary run's MemoryDB head`,
      async ({ prisma, redisOptions }) => {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const producer = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-only", {
          worker: { disabled: false, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        });
        const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);

        let runId = "";
        try {
          await setupBackgroundWorker(producer, env, "test-task", undefined, {
            maxAttempts: 2,
            minTimeoutInMs: 10,
            maxTimeoutInMs: 10,
          });

          async function dequeueOnConsumer() {
            for (let i = 0; i < 25; i++) {
              await producer.runQueue.processMasterQueueForEnvironment(env.id, 5);
              const dequeued = await consumer.dequeueFromWorkerQueue({
                consumerId: "restore_consumer",
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
              friendlyId: "run_rstroute",
              environment: env,
              taskIdentifier: "test-task",
              payload: "{}",
              payloadType: "application/json",
              context: {},
              traceContext: {},
              traceId: "t-restore",
              spanId: "s-restore",
              workerQueue: "main",
              queue: "task/test-task",
              isTest: false,
              tags: [],
              delayUntil: new Date(Date.now() + 60_000),
            },
            prisma
          );
          runId = run.id;

          await prisma.taskRun.update({
            where: { id: runId },
            data: { delayUntil: null, queueTimestamp: new Date() },
          });
          const runRow = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
          await producer.enqueueSystem.enqueueRun({ run: runRow, env, enableFastPath: true });

          const first = await dequeueOnConsumer();
          assertNonNullable(first);
          const route = first.snapshotRoute;
          expect(route?.residency).toBe("redis-primary");

          const attempt = await consumer.startRunAttempt({
            runId,
            snapshotId: first.snapshot.id,
            snapshotRoute: route,
          });

          const waitpoint = await producer.createManualWaitpoint({
            environmentId: env.id,
            projectId: env.projectId,
          });
          const blocked = await consumer.blockRunWithWaitpoint({
            runId,
            waitpoints: waitpoint.waitpoint.id,
            projectId: env.projectId,
            organizationId: env.organizationId,
            snapshotRoute: route,
          });
          expect(blocked.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
          expect(attempt.snapshot.executionStatus).toBe("EXECUTING");

          const checkpoint = await consumer.createCheckpoint({
            runId,
            snapshotId: blocked.id,
            checkpoint: {
              type: "DOCKER",
              reason: "TEST_CHECKPOINT",
              location: "test-location",
              imageRef: "test-image-ref",
            },
            snapshotRoute: route,
          });
          expect(checkpoint.ok).toBe(true);

          await producer.completeWaitpoint({ id: waitpoint.waitpoint.id });

          const restore = await dequeueOnConsumer();
          assertNonNullable(restore);
          expect(restore.snapshot.executionStatus).toBe("PENDING_EXECUTING");
          assertNonNullable(restore.checkpoint);

          const retryErrors: unknown[] = [];
          consumer.eventBus.on("runRetryScheduled", (event) => {
            retryErrors.push(event.run.error);
          });

          const result = await consumer.reportRestoreOutcome({
            runId,
            snapshotId: restore.snapshot.id,
            outcome,
            reason: "NodeLost",
            message: "node-a is gone",
          });
          expect(result).toEqual({ ok: true, outcome });
          expect(retryErrors).toEqual(
            outcome === "fail"
              ? [
                  {
                    type: "INTERNAL_ERROR",
                    code: "TASK_RUN_CRASHED",
                    message: "The run could not be restored: NodeLost",
                  },
                ]
              : []
          );

          const latest = await consumer.getRunExecutionData({ runId });
          assertNonNullable(latest);
          expect(latest.snapshot.executionStatus).toBe("QUEUED");
          const head = await snapshotStore.getLatest(runId);
          assertNonNullable(head);
          expect(head.id).toBe(latest.snapshot.id);
          expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

          const redelivered = await dequeueOnConsumer();
          assertNonNullable(redelivered);
          expect(redelivered.snapshot.executionStatus).toBe("PENDING_EXECUTING");
          if (outcome === "requeue") {
            expect(redelivered.checkpoint?.id).toBe(restore.checkpoint.id);
          } else {
            expect(redelivered.checkpoint).toBeUndefined();
          }
        } finally {
          await producer.quit();
          await consumer.quit();
          await snapshotStore.quit();
        }
      }
    );
  }
});
