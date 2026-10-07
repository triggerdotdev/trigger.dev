// A separate start-attempt request carries no storage contract. The server recovers birth residency
// from durable evidence on a poll-lagging pod. Real queue, engine, Postgres and Redis, no mocks.
import { containerTest } from "@internal/testcontainers";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
  type CreateRunData,
} from "@internal/run-store";
import { trace } from "@internal/tracing";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const LOGICAL_ROUTE = "logical:1";
const TASK = "attempt-task";

function engineOptions(redisOptions: any, prisma: any, store: any) {
  return {
    store,
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

function buildRunRow(params: {
  runId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunData {
  return {
    id: params.runId,
    engine: "V2",
    status: "PENDING",
    friendlyId: `run_${params.runId.slice(-16)}`,
    runtimeEnvironmentId: params.runtimeEnvironmentId,
    environmentType: "PRODUCTION",
    organizationId: params.organizationId,
    projectId: params.projectId,
    taskIdentifier: TASK,
    payload: "{}",
    payloadType: "application/json",
    traceContext: {},
    traceId: `trace_${params.runId.slice(-8)}`,
    spanId: `span_${params.runId.slice(-8)}`,
    queue: `task/${TASK}`,
    workerQueue: "main",
    isTest: false,
    taskEventStore: "taskEvent",
    depth: 0,
    createdAt: new Date(),
  };
}

function tresCount(prisma: PrismaClient, id: string): Promise<number> {
  return prisma.taskRunExecutionSnapshot.count({ where: { id } });
}

describe("startRunAttempt preserves server-side residency through queue->dequeue->start", () => {
  containerTest(
    "a poll-lagging consumer starting a redis-primary run advances the MemoryDB head and writes no TRES row",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const memoryDb = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const resolver = new SnapshotResidencyResolver({
        store: memoryDb,
      });

      // The producer pod SEES the org dial (redis-only): it births the run redis-primary and stamps the
      // route on the re-enqueued message.
      const producer = new TaskRunExecutionSnapshotStore(delegate, {
        store: memoryDb,
        mode: "redis-only",
        resolveDial: () => "redis-only",
        residencyResolver: resolver,
        logicalRunStoreRoute: LOGICAL_ROUTE,
      });

      // The consuming pod is poll-lagging: durable evidence, not its current dial, governs this run.
      const consumer = new TaskRunExecutionSnapshotStore(delegate, {
        store: memoryDb,
        mode: "redis-only",
        resolveDial: () => undefined,
        residencyResolver: resolver,
        logicalRunStoreRoute: LOGICAL_ROUTE,
      });

      const engine = new RunEngine(engineOptions(redisOptions, prisma, consumer));

      try {
        await setupBackgroundWorker(engine, environment, TASK);

        // Birth the run redis-primary through the producer (dial = redis-only), with a dequeueable
        // QUEUED head.
        const runId = `run_${generateInternalId()}`;
        await producer.createRun({
          data: buildRunRow({
            runId,
            organizationId: environment.organization.id,
            projectId: environment.project.id,
            runtimeEnvironmentId: environment.id,
          }),
          snapshot: {
            engine: "V2",
            executionStatus: "QUEUED",
            description: "Run was created",
            runStatus: "PENDING",
            environmentId: environment.id,
            environmentType: "PRODUCTION",
            projectId: environment.project.id,
            organizationId: environment.organization.id,
          },
        });
        expect(await memoryDb.readBirthResidency(runId)).toBe("redis-primary");

        // Stamp the route from the producer's view of durable residency and re-enqueue (real path).
        const route = await producer.readSnapshotRoute(runId, environment.organization.id);
        expect(route?.residency).toBe("redis-primary");

        const runRow = await prisma.taskRun.findUniqueOrThrow({ where: { id: runId } });
        await engine.enqueueSystem.publishRun({
          run: runRow,
          env: environment,
          enableFastPath: true,
        });

        // Move the message onto the worker queue and dequeue it as the poll-lagging consumer.
        await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "consumer_pod_1",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(1);
        const message = dequeued[0]!;

        expect(message).not.toHaveProperty("snapshotRoute");

        // Dequeue's own PENDING_EXECUTING snapshot already honored the route: MemoryDB head advanced, no
        // Postgres row.
        const pendingExecutingId = message.snapshot.id;
        expect((await memoryDb.getLatest(runId))?.id).toBe(pendingExecutingId);
        expect(await tresCount(prisma, pendingExecutingId)).toBe(0);

        // The unchanged worker request contains only run/snapshot identity.
        const result = await engine.startRunAttempt({
          runId,
          snapshotId: pendingExecutingId,
        });

        const executingId = result.snapshot.id;
        // The head advances in its original store without creating a Postgres TRES row.
        expect((await memoryDb.getLatest(runId))?.id).toBe(executingId);
        expect(await tresCount(prisma, executingId)).toBe(0);
      } finally {
        await engine.quit();
        await memoryDb.quit();
      }
    }
  );
});
