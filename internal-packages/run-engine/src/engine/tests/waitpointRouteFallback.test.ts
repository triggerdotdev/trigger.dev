// F4: the waitpoint suspend/resume transitions must honor durable residency even when NO route is
// carried. blockRunWithWaitpoint and continueRunIfUnblocked resolve the run's residency durably ONCE
// when the caller supplies no route (e.g. a batch/duration block, or the completeWaitpoint-scheduled
// resume). Two engines model two pods: a PRODUCER (dial=redis-only) births the run redis-primary, an
// undefined-dial CONSUMER drives the route-less waitpoint transitions. Real infra, no mocks.
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

describe("RunEngine waitpoint route fallback (F4)", () => {
  containerTest(
    "route-less blockRunWithWaitpoint and continueRunIfUnblocked stay resident on a dial=undefined consumer",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const producer = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-only", {
        worker: { workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      });
      const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);

      let runId = "";
      try {
        await setupBackgroundWorker(producer, env, "test-task");

        async function expectResidentHead(snapshotId: string) {
          expect(
            await prisma.taskRunExecutionSnapshot.count({ where: { id: snapshotId } }),
            `snapshot ${snapshotId} must NOT be a Postgres TRES row`
          ).toBe(0);
          const head = await snapshotStore.getLatest(runId);
          assertNonNullable(head);
          expect(head.id).toBe(snapshotId);
        }

        async function dequeueOnConsumer() {
          for (let i = 0; i < 25; i++) {
            await producer.runQueue.processMasterQueueForEnvironment(env.id, 5);
            const dequeued = await consumer.dequeueFromWorkerQueue({
              consumerId: "wpf_consumer",
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
            friendlyId: "run_wpf",
            environment: env,
            taskIdentifier: "test-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-wpf",
            spanId: "s-wpf",
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

        const dequeued = await dequeueOnConsumer();
        const controllerRoute = dequeued.snapshotRoute;
        const attempt = await consumer.startRunAttempt({
          runId,
          snapshotId: dequeued.snapshot.id,
          snapshotRoute: controllerRoute,
        });
        expect(attempt.snapshot.executionStatus).toBe("EXECUTING");
        await expectResidentHead(attempt.snapshot.id);

        // ---- F4-a: block WITHOUT a carried route. The consumer's dial is undefined, so only the durable
        // fallback keeps the EXECUTING_WITH_WAITPOINTS snapshot resident. ----
        const waitpoint = await producer.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });
        const blocked = await consumer.blockRunWithWaitpoint({
          runId,
          waitpoints: waitpoint.waitpoint.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
          // no snapshotRoute — forces the durable fallback
        });
        expect(blocked.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
        await expectResidentHead(blocked.id);

        // ---- F4-b: resume WITHOUT a carried route (as the completeWaitpoint-scheduled job would on a
        // poll-lagging pod). The EXECUTING_WITH_WAITPOINTS resume path resolves residency durably. ----
        await producer.completeWaitpoint({ id: waitpoint.waitpoint.id });
        const result = await consumer.waitpointSystem.continueRunIfUnblocked({ runId });
        expect(result.status).toBe("unblocked");

        const resumed = await consumer.getRunExecutionData({ runId });
        assertNonNullable(resumed);
        expect(resumed.snapshot.executionStatus).toBe("EXECUTING");
        await expectResidentHead(resumed.snapshot.id);

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );
});
