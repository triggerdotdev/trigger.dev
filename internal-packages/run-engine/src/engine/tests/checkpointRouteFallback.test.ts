// Devin 83 (checkpoint suspension loses residency): createCheckpoint must honor a redis-primary run's
// durable residency even when the caller carries NO route. The managed suspend flow may not thread the
// route through every supervisor hop, so on a poll-lagging / undefined-dial webapp the SUSPENDED
// transition would take the inert Postgres shortcut and strand the run's MemoryDB head. createCheckpoint
// now resolves the route once (forceDurable) as a central fallback (after its discard early-exits). This
// drives the real queue -> dequeue -> start-attempt chain, then checkpoints ROUTE-LESS on an
// undefined-dial engine and proves the SUSPENDED head advances in MemoryDB with no Postgres TRES row.
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
const TASK = "checkpoint-task";

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

describe("createCheckpoint honors durable residency when the caller carries no route", () => {
  containerTest(
    "a route-less checkpoint on a dial=undefined engine advances a redis-primary run's MemoryDB head to SUSPENDED (no TRES)",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const memoryDb = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const resolver = new SnapshotResidencyResolver({
        store: memoryDb,
        taskRunExists: async (id) => (await prisma.taskRun.count({ where: { id } })) > 0,
      });

      const producer = new TaskRunExecutionSnapshotStore(delegate, {
        store: memoryDb,
        mode: "redis-only",
        resolveDial: () => "redis-only",
        residencyResolver: resolver,
        logicalRunStoreRoute: LOGICAL_ROUTE,
      });
      // The completing pod is poll-lagging: its dial reads undefined. Route-less, it would strand the run.
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

        const route = await producer.readSnapshotRoute(runId, environment.organization.id);
        expect(route?.residency).toBe("redis-primary");

        const runRow = await prisma.taskRun.findUniqueOrThrow({ where: { id: runId } });
        await engine.enqueueSystem.publishRun({
          run: runRow,
          env: environment,
          route: route ?? undefined,
          enableFastPath: true,
        });

        await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "consumer_pod_1",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(1);
        const message = dequeued[0]!;

        // Reach EXECUTING carrying the route (covered by startRunAttemptSnapshotRoute.test.ts).
        const started = await engine.startRunAttempt({
          runId,
          snapshotId: message.snapshot.id,
          snapshotRoute: message.snapshotRoute,
        });
        const executingId = started.snapshot.id;
        expect((await memoryDb.getLatest(runId))?.id).toBe(executingId);

        // The fix under test: checkpoint WITHOUT a route (the supervisor suspend flow may not thread it
        // through every hop). The undefined-dial engine must resolve the residency durably so the
        // SUSPENDED transition lands in MemoryDB.
        const checkpointed = await engine.createCheckpoint({
          runId,
          snapshotId: executingId,
          checkpoint: {
            type: "DOCKER",
            reason: "TEST_CHECKPOINT",
            location: "test-location",
            imageRef: "test-image-ref",
          },
        });
        expect(checkpointed.ok).toBe(true);
        const suspendedId = checkpointed.ok ? checkpointed.snapshot.id : "";
        expect(checkpointed.ok && checkpointed.snapshot.executionStatus).toBe("SUSPENDED");

        // GREEN: the SUSPENDED transition honored the redis-primary route, so the MemoryDB head advanced
        // and no TRES row was written. RED (no fallback): the undefined dial takes the Postgres shortcut,
        // writing a TRES row and stranding the head at EXECUTING.
        expect((await memoryDb.getLatest(runId))?.id).toBe(suspendedId);
        expect(await tresCount(prisma, suspendedId)).toBe(0);
      } finally {
        await engine.quit();
        await memoryDb.quit();
      }
    }
  );
});
