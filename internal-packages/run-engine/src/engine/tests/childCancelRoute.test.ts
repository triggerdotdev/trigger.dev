// F5: recursive child cancellation must resolve EACH child's OWN residency with forceDurable (a child
// has its own birth residency) and stamp it on the queued cancelRun payload, so the cancel consumer
// honors the child's true residency without a lookup of its own. Here a PRODUCER (dial=redis-only)
// births a parent + a redis-primary child; the CONSUMER (dial=undefined) cancels the parent and its
// own worker runs the child cancel on the undefined dial. The child's terminal snapshot must stay in
// MemoryDB with no TRES row. No mocks.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreDial,
} from "@internal/run-store";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const ROUTE = "logical:1";
const machines = {
  defaultMachine: "small-1x",
  machines: {
    "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
  },
  baseCostInCents: 0.0001,
};

function makeStore(
  prisma: any,
  snapshotStore: RedisSnapshotStore,
  dial: () => SnapshotStoreDial | undefined
) {
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  return new TaskRunExecutionSnapshotStore(delegate, {
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
}

describe("RunEngine recursive child-cancel route (F5)", () => {
  containerTest(
    "child cancel scheduled by a dial=undefined consumer honors the child's own durable residency (no TRES)",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      const producer = new RunEngine({
        prisma,
        store: makeStore(prisma, snapshotStore, () => "redis-only"),
        worker: { redis: redisOptions, disabled: true },
        queue: {
          redis: redisOptions,
          masterQueueConsumersDisabled: true,
          processWorkerQueueDebounceMs: 50,
        },
        runLock: { redis: redisOptions },
        machines,
        tracer: trace.getTracer("test", "0.0.0"),
      });
      const consumer = new RunEngine({
        prisma,
        store: makeStore(prisma, snapshotStore, () => undefined),
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: {
          redis: redisOptions,
          masterQueueConsumersDisabled: true,
          processWorkerQueueDebounceMs: 50,
        },
        runLock: { redis: redisOptions },
        machines,
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        await setupBackgroundWorker(producer, env, ["parent-task", "child-task"]);

        // Parent, driven to EXECUTING on the consumer.
        const parent = await producer.trigger(
          {
            number: 1,
            friendlyId: "run_parent",
            environment: env,
            taskIdentifier: "parent-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-parent",
            spanId: "s-parent",
            workerQueue: "main",
            queue: "task/parent-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        let dq;
        for (let i = 0; i < 25; i++) {
          await producer.runQueue.processMasterQueueForEnvironment(env.id, 5);
          const d = await consumer.dequeueFromWorkerQueue({
            consumerId: "cc_consumer",
            workerQueue: "main",
          });
          if (d.length > 0) {
            dq = d[0];
            break;
          }
          await setTimeout(200);
        }
        assertNonNullable(dq);
        const parentAttempt = await consumer.startRunAttempt({
          runId: parent.id,
          snapshotId: dq.snapshot.id,
          snapshotRoute: dq.snapshotRoute,
        });
        expect(parentAttempt.snapshot.executionStatus).toBe("EXECUTING");

        // Redis-primary child of the parent, left QUEUED.
        const child = await producer.trigger(
          {
            number: 1,
            friendlyId: "run_child",
            environment: env,
            taskIdentifier: "child-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-child",
            spanId: "s-child",
            workerQueue: "main",
            queue: "task/child-task",
            isTest: false,
            tags: [],
            resumeParentOnCompletion: true,
            parentTaskRunId: parent.id,
          },
          prisma
        );
        expect(await snapshotStore.readBirthResidency(child.id)).toBe("redis-primary");
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: child.id } })).toBe(0);

        // The undefined-dial consumer cancels the parent; its worker runs the recursive child cancel.
        await consumer.cancelRun({
          runId: parent.id,
          finalizeRun: true,
          snapshotRoute: dq.snapshotRoute,
        });

        let childData;
        for (let i = 0; i < 30; i++) {
          await setTimeout(300);
          const data = await consumer.getRunExecutionData({ runId: child.id });
          if (data?.snapshot.executionStatus === "FINISHED") {
            childData = data;
            break;
          }
        }
        assertNonNullable(childData);
        expect(childData.snapshot.executionStatus).toBe("FINISHED");
        expect(childData.run.status).toBe("CANCELED");

        // The child's terminal snapshot is resident: no TRES row, MemoryDB head advanced to it.
        expect(
          await prisma.taskRunExecutionSnapshot.count({ where: { id: childData.snapshot.id } }),
          `child terminal snapshot ${childData.snapshot.id} must NOT be a Postgres TRES row`
        ).toBe(0);
        const head = await snapshotStore.getLatest(child.id);
        assertNonNullable(head);
        expect(head.id).toBe(childData.snapshot.id);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: child.id } })).toBe(0);
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );
});
