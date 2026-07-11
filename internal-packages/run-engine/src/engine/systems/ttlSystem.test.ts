import {
  containerTest,
  assertNonNullable,
  heteroPostgresTest,
  network,
  redisContainer,
  redisOptions,
} from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { Decimal } from "@trigger.dev/database";
import { PostgresRunStore } from "@internal/run-store";
import type { RunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";

// heteroPostgresTest provides two postgres clients but no redis; compose a fixture
// that adds a per-test redis container + options for the engine.
const heteroEngineTest = heteroPostgresTest.extend<{
  network: any;
  redisContainer: any;
  redisOptions: any;
}>({
  network,
  redisContainer,
  redisOptions,
});

vi.setConfig({ testTimeout: 60_000 });

// Real PostgresRunStore subclass (no mocks) counting routed method calls.
class CountingPostgresRunStore extends PostgresRunStore {
  public calls = {
    rescheduleRun: 0,
    enqueueDelayedRun: 0,
    expireRun: 0,
    expireRunsBatch: 0,
    findRun: 0,
    findRuns: 0,
    findLatestExecutionSnapshot: 0,
    forWaitpointCompletion: 0,
  };

  // expireRun is generic over the select payload; keep the loose arg list so the
  // override still satisfies the generic interface signature.
  override expireRun(...args: any[]): any {
    this.calls.expireRun++;
    return super.expireRun(...(args as [any, any, any, any]));
  }

  override expireRunsBatch(...args: Parameters<PostgresRunStore["expireRunsBatch"]>) {
    this.calls.expireRunsBatch++;
    return super.expireRunsBatch(...args);
  }

  override findRun(...args: any[]): any {
    this.calls.findRun++;
    return super.findRun(...(args as [any, any, any]));
  }

  override findRuns(...args: any[]): any {
    this.calls.findRuns++;
    return super.findRuns(...(args as [any, any]));
  }

  override findLatestExecutionSnapshot(
    ...args: Parameters<PostgresRunStore["findLatestExecutionSnapshot"]>
  ) {
    this.calls.findLatestExecutionSnapshot++;
    return super.findLatestExecutionSnapshot(...args);
  }

  override forWaitpointCompletion(...args: Parameters<PostgresRunStore["forWaitpointCompletion"]>) {
    this.calls.forWaitpointCompletion++;
    return super.forWaitpointCompletion(...args);
  }
}

function createEngine(
  prisma: PrismaClient,
  redisOptions: any,
  store?: RunStore,
  extraQueueOptions?: Record<string, unknown>
) {
  return new RunEngine({
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
      processWorkerQueueDebounceMs: 50,
      masterQueueConsumersDisabled: true,
      ...extraQueueOptions,
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
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

const triggerDefaults = {
  payload: "{}",
  payloadType: "application/json" as const,
  context: {},
  traceContext: {},
  isTest: false,
  tags: [] as string[],
  workerQueue: "main",
};

describe("TtlSystem store routing", () => {
  containerTest(
    "expireRun routes snapshot read + findRun + expire through the store and completes the waitpoint via the guard",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      // ttlSystem disabled so the batch path does not race the direct expireRun call.
      const engine = createEngine(prisma, redisOptions, store, {
        ttlSystem: { disabled: true },
      });

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

        // Cap env concurrency at exactly 1 so the parent takes the only slot and the
        // child stays PENDING/QUEUED (expireRun only expires PENDING, non-locked runs).
        await engine.runQueue.updateEnvConcurrencyLimits({
          ...authenticatedEnvironment,
          maximumConcurrencyLimit: 1,
          concurrencyLimitBurstFactor: new Decimal(1.0),
        });

        const parentRun = await engine.trigger(
          {
            ...triggerDefaults,
            number: 1,
            friendlyId: "run_p1234",
            environment: authenticatedEnvironment,
            taskIdentifier: parentTask,
            traceId: "t12345",
            spanId: "s12345",
            queue: `task/${parentTask}`,
          },
          prisma
        );

        await engine.runQueue.processMasterQueueForEnvironment(authenticatedEnvironment.id, 10);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
          blockingPopTimeoutSeconds: 1,
        });
        expect(dequeued.length).toBe(1);

        const initialExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(initialExecutionData);
        await engine.startRunAttempt({
          runId: parentRun.id,
          snapshotId: initialExecutionData.snapshot.id,
        });

        // Child run with a waitpoint resuming the parent. TTL is set but the batch
        // path is disabled, so the child stays PENDING until we expire it directly.
        const childRun = await engine.trigger(
          {
            ...triggerDefaults,
            number: 2,
            friendlyId: "run_c1234",
            environment: authenticatedEnvironment,
            taskIdentifier: childTask,
            traceId: "t12346",
            spanId: "s12346",
            queue: `task/${childTask}`,
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun.id,
            ttl: "60s",
          },
          prisma
        );

        const runWaitpoint = await prisma.taskRunWaitpoint.findFirst({
          where: { taskRunId: parentRun.id },
          include: { waitpoint: true },
        });
        assertNonNullable(runWaitpoint);
        expect(runWaitpoint.waitpoint.type).toBe("RUN");
        expect(runWaitpoint.waitpoint.completedByTaskRunId).toBe(childRun.id);

        // Confirm the child is PENDING (the expireRun precondition) before expiring.
        const childBefore = await prisma.taskRun.findUniqueOrThrow({ where: { id: childRun.id } });
        expect(childBefore.status).toBe("PENDING");

        store.calls.findLatestExecutionSnapshot = 0;
        store.calls.findRun = 0;
        store.calls.expireRun = 0;
        store.calls.forWaitpointCompletion = 0;

        await engine.ttlSystem.expireRun({ runId: childRun.id });

        expect(store.calls.findLatestExecutionSnapshot).toBeGreaterThanOrEqual(1);
        expect(store.calls.findRun).toBeGreaterThanOrEqual(1);
        expect(store.calls.expireRun).toBeGreaterThanOrEqual(1);
        // The waitpoint-completion guard fired for the expireRun completion path.
        expect(store.calls.forWaitpointCompletion).toBeGreaterThanOrEqual(1);

        const expiredChild = await prisma.taskRun.findUniqueOrThrow({ where: { id: childRun.id } });
        expect(expiredChild.status).toBe("EXPIRED");

        const finishedSnapshots = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: childRun.id, executionStatus: "FINISHED" },
        });
        expect(finishedSnapshots.length).toBeGreaterThanOrEqual(1);

        const waitpointAfter = await prisma.waitpoint.findFirstOrThrow({
          where: { id: runWaitpoint.waitpointId },
        });
        expect(waitpointAfter.status).toBe("COMPLETED");
        expect(waitpointAfter.outputIsError).toBe(true);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "expireRun with a caller tx still routes the snapshot read through the store",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      // ttlSystem disabled so the batch path does not race the direct expireRun call.
      const engine = createEngine(prisma, redisOptions, store, {
        ttlSystem: { disabled: true },
      });

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

        // Cap env concurrency at exactly 1 so the parent takes the only slot and the
        // child stays PENDING/QUEUED (expireRun only expires PENDING, non-locked runs).
        await engine.runQueue.updateEnvConcurrencyLimits({
          ...authenticatedEnvironment,
          maximumConcurrencyLimit: 1,
          concurrencyLimitBurstFactor: new Decimal(1.0),
        });

        const parentRun = await engine.trigger(
          {
            ...triggerDefaults,
            number: 1,
            friendlyId: "run_ptx12",
            environment: authenticatedEnvironment,
            taskIdentifier: parentTask,
            traceId: "tptx12",
            spanId: "sptx12",
            queue: `task/${parentTask}`,
          },
          prisma
        );

        await engine.runQueue.processMasterQueueForEnvironment(authenticatedEnvironment.id, 10);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_ctx12",
          workerQueue: "main",
          blockingPopTimeoutSeconds: 1,
        });
        expect(dequeued.length).toBe(1);

        const initialExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(initialExecutionData);
        await engine.startRunAttempt({
          runId: parentRun.id,
          snapshotId: initialExecutionData.snapshot.id,
        });

        const childRun = await engine.trigger(
          {
            ...triggerDefaults,
            number: 2,
            friendlyId: "run_ctx12",
            environment: authenticatedEnvironment,
            taskIdentifier: childTask,
            traceId: "tctx13",
            spanId: "sctx13",
            queue: `task/${childTask}`,
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun.id,
            ttl: "60s",
          },
          prisma
        );

        const childBefore = await prisma.taskRun.findUniqueOrThrow({ where: { id: childRun.id } });
        expect(childBefore.status).toBe("PENDING");

        store.calls.findLatestExecutionSnapshot = 0;
        store.calls.findRun = 0;
        store.calls.expireRun = 0;

        // Pass a caller tx: the snapshot read must still route through the store (which
        // resolves the owning DB), never read the caller's control-plane tx directly.
        await engine.ttlSystem.expireRun({ runId: childRun.id, tx: prisma });

        expect(store.calls.findLatestExecutionSnapshot).toBeGreaterThanOrEqual(1);

        const persisted = await prisma.taskRun.findUniqueOrThrow({ where: { id: childRun.id } });
        expect(persisted.status).toBe("EXPIRED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "expireRunsBatch routes bulk fetch + bulk expire through the store",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = createEngine(prisma, redisOptions, store, {
        ttlSystem: { disabled: true },
      });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Keep the runs queued (PENDING) so the batch can expire them.
        await engine.runQueue.updateEnvConcurrencyLimits({
          ...authenticatedEnvironment,
          maximumConcurrencyLimit: 0,
        });

        const runs = await Promise.all(
          [1, 2, 3].map((n) =>
            engine.trigger(
              {
                ...triggerDefaults,
                number: n,
                friendlyId: `run_batch${n}`,
                environment: authenticatedEnvironment,
                taskIdentifier,
                traceId: `t_b${n}`,
                spanId: `s_b${n}`,
                queue: "task/test-task",
                ttl: "60s",
              },
              prisma
            )
          )
        );

        for (const run of runs) {
          const executionData = await engine.getRunExecutionData({ runId: run.id });
          assertNonNullable(executionData);
          expect(executionData.snapshot.executionStatus).toBe("QUEUED");
        }

        store.calls.findRuns = 0;
        store.calls.expireRunsBatch = 0;

        const runIds = runs.map((r) => r.id);
        const result = await engine.ttlSystem.expireRunsBatch(runIds);

        expect(store.calls.findRuns).toBeGreaterThanOrEqual(1);
        expect(store.calls.expireRunsBatch).toBeGreaterThanOrEqual(1);

        expect(result.expired.length).toBe(3);
        expect(result.skipped.length).toBe(0);

        for (const run of runs) {
          const dbRun = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
          expect(dbRun.status).toBe("EXPIRED");
        }
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("single-DB binds one client (passthrough)", async ({ prisma, redisOptions }) => {
    // Default-store engine: an expire round-trip must persist on the one client.
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const engine = createEngine(prisma, redisOptions, undefined, {
      ttlSystem: { disabled: true },
    });

    try {
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      await engine.runQueue.updateEnvConcurrencyLimits({
        ...authenticatedEnvironment,
        maximumConcurrencyLimit: 0,
      });

      const run = await engine.trigger(
        {
          ...triggerDefaults,
          number: 1,
          friendlyId: "run_passttl",
          environment: authenticatedEnvironment,
          taskIdentifier,
          traceId: "t_passttl",
          spanId: "s_passttl",
          queue: "task/test-task",
          ttl: "60s",
        },
        prisma
      );

      await engine.ttlSystem.expireRun({ runId: run.id });

      const dbRun = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(dbRun.status).toBe("EXPIRED");
    } finally {
      await engine.quit();
    }
  });

  heteroEngineTest(
    "expireRun post-migration completion routes via the guard to the owning store",
    async ({ prisma14, prisma17, redisOptions }) => {
      // An expirable PENDING run + associatedWaitpoint is seeded on the NEW DB (PG17).
      // expireRun (unchanged) must route its completion to NEW (waitpoint COMPLETED +
      // run EXPIRED on PG17) and leave the LEGACY DB (PG14) untouched.

      const _legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });

      const residency = new Map<string, RunStore>();
      // forWaitpointCompletion has no run id, so default the router to NEW: the seeded
      // run and its waitpoint both live on NEW.
      const router = createRouter(residency, newStore);

      const _env14 = await setupAuthenticatedEnvironment(prisma14, "PRODUCTION");
      const env17 = await setupAuthenticatedEnvironment(prisma17, "PRODUCTION");

      const engine = createEngine(prisma17, redisOptions, router, {
        ttlSystem: { disabled: true },
      });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env17, taskIdentifier);

        const runId = "run_hetero_ttl";
        const waitpointId = "wp_hetero_ttl";

        // Create the run with an associated waitpoint + latest snapshot on NEW (PG17).
        await newStore.createRun(
          {
            data: {
              id: runId,
              engine: "V2",
              status: "PENDING",
              friendlyId: "run_ht1",
              runtimeEnvironmentId: env17.id,
              environmentType: "PRODUCTION",
              organizationId: env17.organization.id,
              projectId: env17.project.id,
              taskIdentifier,
              payload: "{}",
              payloadType: "application/json",
              traceContext: {},
              traceId: "t_ht",
              spanId: "s_ht",
              queue: "task/test-task",
              workerQueue: "main",
              isTest: false,
              ttl: "60s",
              queuedAt: new Date(),
            },
            snapshot: {
              engine: "V2",
              executionStatus: "QUEUED",
              description: "Run was created",
              runStatus: "PENDING",
              environmentId: env17.id,
              environmentType: "PRODUCTION",
              projectId: env17.project.id,
              organizationId: env17.organization.id,
            },
            associatedWaitpoint: {
              id: waitpointId,
              friendlyId: "wp_ht1",
              type: "RUN",
              status: "PENDING",
              idempotencyKey: "idem_ht",
              userProvidedIdempotencyKey: false,
              projectId: env17.project.id,
              environmentId: env17.id,
            },
          },
          prisma17
        );
        residency.set(runId, newStore);

        // Sanity: nothing on LEGACY.
        const legacyBefore = await prisma14.taskRun.findUnique({ where: { id: runId } });
        expect(legacyBefore).toBeNull();

        await engine.ttlSystem.expireRun({ runId });

        // Completion routed to NEW: run EXPIRED + waitpoint COMPLETED with error.
        const newRun = await prisma17.taskRun.findUniqueOrThrow({ where: { id: runId } });
        expect(newRun.status).toBe("EXPIRED");

        const newWaitpoint = await prisma17.waitpoint.findUniqueOrThrow({
          where: { id: waitpointId },
        });
        expect(newWaitpoint.status).toBe("COMPLETED");
        expect(newWaitpoint.outputIsError).toBe(true);

        // LEGACY untouched.
        const legacyAfter = await prisma14.taskRun.findUnique({ where: { id: runId } });
        expect(legacyAfter).toBeNull();
        const legacyWaitpoint = await prisma14.waitpoint.findUnique({ where: { id: waitpointId } });
        expect(legacyWaitpoint).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );
});

// A minimal two-store router implementing RunStore by delegating each method to the
// store that owns the run id. Methods with a runId first arg resolve by residency;
// bulk reads resolve by the first id; methods without a run id use the default store.
export function createRouter(residency: Map<string, RunStore>, defaultStore: RunStore): RunStore {
  const resolveById = (runId: string): RunStore => residency.get(runId) ?? defaultStore;

  const handler: ProxyHandler<RunStore> = {
    get(_target, prop: string | symbol) {
      switch (prop) {
        case "rescheduleRun":
        case "enqueueDelayedRun":
        case "expireRun":
        case "findLatestExecutionSnapshot":
        case "startAttempt":
        case "completeAttemptSuccess":
        case "recordRetryOutcome":
        case "requeueRun":
        case "recordBulkActionMembership":
        case "cancelRun":
        case "failRunPermanently":
        case "lockRunToWorker":
        case "parkPendingVersion":
        case "promotePendingVersionRuns":
        case "suspendForCheckpoint":
        case "resumeFromCheckpoint":
        case "rewriteDebouncedRun":
        case "updateMetadata":
        case "pushTags":
        case "pushRealtimeStream":
        case "findSnapshotCompletedWaitpointIds":
          return (...args: any[]) => (resolveById(args[0]) as any)[prop](...args);

        case "findRun":
        case "findRunOrThrow":
          return (...args: any[]) => {
            const where = args[0];
            const id = where && typeof where.id === "string" ? where.id : undefined;
            const store = id ? resolveById(id) : defaultStore;
            return (store as any)[prop](...args);
          };

        case "expireRunsBatch":
          return (...args: any[]) => {
            const runIds: string[] = args[0] ?? [];
            const store = runIds.length > 0 ? resolveById(runIds[0]) : defaultStore;
            return (store as any)[prop](...args);
          };

        case "findRuns":
          return (...args: any[]) => {
            const inList = args[0]?.where?.id?.in as string[] | undefined;
            const store = inList && inList.length > 0 ? resolveById(inList[0]) : defaultStore;
            return (store as any)[prop](...args);
          };

        default:
          return (...args: any[]) => (defaultStore as any)[prop](...args);
      }
    },
  };

  return new Proxy({} as RunStore, handler);
}
