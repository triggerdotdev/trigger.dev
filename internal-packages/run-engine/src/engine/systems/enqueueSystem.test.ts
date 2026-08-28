import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { getLatestExecutionSnapshot } from "../systems/executionSnapshotSystem.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";

vi.setConfig({ testTimeout: 60_000 });

function createEngineOptions(redisOptions: any, prisma: any, store?: PostgresRunStore) {
  return {
    prisma,
    ...(store ? { store } : {}),
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
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x" as const,
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
  };
}

/**
 * A real PostgresRunStore subclass that counts the store methods a run's QUEUED snapshot can be
 * written through: nested in `createRun` on the trigger path, or standalone via
 * `createExecutionSnapshot` on every re-enqueue. super.* runs the genuine store implementation, so
 * the routing is observed over real containers without ever mocking prisma or the store.
 */
class CountingPostgresRunStore extends PostgresRunStore {
  /** Snapshots written nested in a run create: the trigger path's QUEUED write. */
  public nestedSnapshotCreates = 0;
  /** Snapshots written standalone through `createExecutionSnapshot`: every re-enqueue. */
  public standaloneSnapshotCreates = 0;

  override async createExecutionSnapshot(
    input: any,
    tx?: any
  ): ReturnType<PostgresRunStore["createExecutionSnapshot"]> {
    this.standaloneSnapshotCreates++;
    return super.createExecutionSnapshot(input, tx);
  }

  override async createRun(
    params: Parameters<PostgresRunStore["createRun"]>[0],
    tx?: any
  ): ReturnType<PostgresRunStore["createRun"]> {
    this.nestedSnapshotCreates++;
    return super.createRun(params, tx);
  }
}

describe("RunEngine enqueueRun store routing", () => {
  containerTest(
    "the QUEUED snapshot routes through the store as a single nested write",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const nestedBefore = countingStore.nestedSnapshotCreates;
        const standaloneBefore = countingStore.standaloneSnapshotCreates;

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
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        expect(countingStore.nestedSnapshotCreates).toBe(nestedBefore + 1);
        expect(countingStore.standaloneSnapshotCreates).toBe(standaloneBefore);

        const latest = await getLatestExecutionSnapshot(prisma, run.id);
        assertNonNullable(latest);
        expect(latest.executionStatus).toBe("QUEUED");

        const snapshotRow = await prisma.taskRunExecutionSnapshot.findFirst({
          where: { runId: run.id, executionStatus: "QUEUED" },
        });
        assertNonNullable(snapshotRow);
        expect(snapshotRow.runId).toBe(run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // The Redis enqueueMessage path is unchanged — the run is dequeuable after enqueueRun.
  containerTest(
    "Redis enqueue is unchanged (run is dequeuable after enqueueRun)",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

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
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_consumer",
          workerQueue: "main",
        });

        expect(dequeued.length).toBe(1);
        expect(dequeued[0].run.id).toBe(run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // Single-DB binds one client (passthrough) — proven by behavior, not by store.prisma === prisma.
  containerTest(
    "single-DB binds one client (passthrough) — snapshot round-trips on the one client",
    async ({ prisma, redisOptions }) => {
      // No `store` injected → the engine builds its default single-client PostgresRunStore.
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

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
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        const latest = await getLatestExecutionSnapshot(prisma, run.id);
        assertNonNullable(latest);
        expect(latest.executionStatus).toBe("QUEUED");
        expect(latest.runId).toBe(run.id);
      } finally {
        await engine.quit();
      }
    }
  );
});
