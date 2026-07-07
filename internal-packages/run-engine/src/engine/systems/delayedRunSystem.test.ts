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
import { PostgresRunStore } from "@internal/run-store";
import type { RunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";

// heteroPostgresTest provides two postgres clients but no redis; the engine needs
// redis. Compose a fixture that adds a per-test redis container + options.
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

// A real PostgresRunStore subclass (no mocks) that counts how many times each
// routed method is invoked, then delegates to the real Prisma-backed
// implementation. The counters let a test prove that a code path resolved its
// reads/writes through the owning store rather than going straight to Prisma.
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

  override rescheduleRun(...args: Parameters<PostgresRunStore["rescheduleRun"]>) {
    this.calls.rescheduleRun++;
    return super.rescheduleRun(...args);
  }

  override enqueueDelayedRun(...args: Parameters<PostgresRunStore["enqueueDelayedRun"]>) {
    this.calls.enqueueDelayedRun++;
    return super.enqueueDelayedRun(...args);
  }

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

  // findRun has three overloads; accept the loose arg list and forward verbatim.
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

describe("DelayedRunSystem store routing", () => {
  containerTest(
    "rescheduleDelayedRun routes snapshot read + reschedule write through the store",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = createEngine(prisma, redisOptions, store);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const run = await engine.trigger(
          {
            ...triggerDefaults,
            number: 1,
            friendlyId: "run_resched1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            traceId: "t_resched",
            spanId: "s_resched",
            queue: "task/test-task",
            delayUntil: new Date(Date.now() + 400),
          },
          prisma
        );

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("DELAYED");

        // Reset counters so we only measure the rescheduleDelayedRun path.
        store.calls.findLatestExecutionSnapshot = 0;
        store.calls.rescheduleRun = 0;

        const rescheduleTo = new Date(Date.now() + 5_000);
        const updatedRun = await engine.rescheduleDelayedRun({
          runId: run.id,
          delayUntil: rescheduleTo,
        });
        expect(updatedRun.delayUntil?.toISOString()).toBe(rescheduleTo.toISOString());

        // The snapshot read routed through the owning store (this is the unit's edit),
        // and the reschedule write routed through the store too.
        expect(store.calls.findLatestExecutionSnapshot).toBeGreaterThanOrEqual(1);
        expect(store.calls.rescheduleRun).toBeGreaterThanOrEqual(1);

        // Persisted state: delayUntil updated and a fresh DELAYED snapshot row exists.
        const persisted = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(persisted.delayUntil?.toISOString()).toBe(rescheduleTo.toISOString());

        const delayedSnapshots = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: run.id, executionStatus: "DELAYED" },
        });
        // Two DELAYED snapshots: the trigger-time one and the reschedule one.
        expect(delayedSnapshots.length).toBeGreaterThanOrEqual(2);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "rescheduleDelayedRun with a caller tx still routes the snapshot read through the store",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = createEngine(prisma, redisOptions, store);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const run = await engine.trigger(
          {
            ...triggerDefaults,
            number: 1,
            friendlyId: "run_reschedtx",
            environment: authenticatedEnvironment,
            taskIdentifier,
            traceId: "t_reschedtx",
            spanId: "s_reschedtx",
            queue: "task/test-task",
            delayUntil: new Date(Date.now() + 400),
          },
          prisma
        );

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("DELAYED");

        // Reset counters so we only measure the rescheduleDelayedRun path.
        store.calls.findLatestExecutionSnapshot = 0;
        store.calls.rescheduleRun = 0;

        // Pass a caller tx: the snapshot read must still route through the store (owning-DB
        // resolution), not read the caller's control-plane tx directly.
        const rescheduleTo = new Date(Date.now() + 5_000);
        const updatedRun = await engine.rescheduleDelayedRun({
          runId: run.id,
          delayUntil: rescheduleTo,
          tx: prisma,
        });

        // The snapshot read routed through the store (owning-DB resolution), not the caller tx.
        expect(store.calls.findLatestExecutionSnapshot).toBeGreaterThanOrEqual(1);

        // The reschedule still succeeded and persisted.
        expect(updatedRun.delayUntil?.toISOString()).toBe(rescheduleTo.toISOString());

        const persisted = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(persisted.delayUntil?.toISOString()).toBe(rescheduleTo.toISOString());
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "enqueueDelayedRun routes snapshot read + findRun + enqueue write through the store",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = createEngine(prisma, redisOptions, store);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Long delay so the background worker job never races our direct call.
        const run = await engine.trigger(
          {
            ...triggerDefaults,
            number: 1,
            friendlyId: "run_enq1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            traceId: "t_enq",
            spanId: "s_enq",
            queue: "task/test-task",
            delayUntil: new Date(Date.now() + 60_000),
          },
          prisma
        );

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("DELAYED");

        // Reset counters so we only measure the enqueueDelayedRun path.
        store.calls.findLatestExecutionSnapshot = 0;
        store.calls.findRun = 0;
        store.calls.enqueueDelayedRun = 0;

        // Drive enqueue directly so timing is deterministic. The run's delayUntil
        // is in the future, so first move it to the past to allow enqueue.
        await prisma.taskRun.update({
          where: { id: run.id },
          data: { delayUntil: new Date(Date.now() - 1_000) },
        });

        await engine.delayedRunSystem.enqueueDelayedRun({ runId: run.id });

        expect(store.calls.findLatestExecutionSnapshot).toBeGreaterThanOrEqual(1);
        expect(store.calls.findRun).toBeGreaterThanOrEqual(1);
        expect(store.calls.enqueueDelayedRun).toBeGreaterThanOrEqual(1);

        const persisted = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(persisted.status).toBe("PENDING");

        const queuedSnapshots = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: run.id, executionStatus: "QUEUED" },
        });
        expect(queuedSnapshots.length).toBeGreaterThanOrEqual(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("single-DB binds one client (passthrough)", async ({ prisma, redisOptions }) => {
    // No custom store: the engine builds a default PostgresRunStore over the one
    // prisma client. A reschedule + enqueue round-trip must land on that one DB.
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const engine = createEngine(prisma, redisOptions);

    try {
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      const run = await engine.trigger(
        {
          ...triggerDefaults,
          number: 1,
          friendlyId: "run_pass1",
          environment: authenticatedEnvironment,
          taskIdentifier,
          traceId: "t_pass",
          spanId: "s_pass",
          queue: "task/test-task",
          delayUntil: new Date(Date.now() + 60_000),
        },
        prisma
      );

      const rescheduleTo = new Date(Date.now() + 90_000);
      await engine.rescheduleDelayedRun({ runId: run.id, delayUntil: rescheduleTo });

      const afterReschedule = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
      expect(afterReschedule.delayUntil?.toISOString()).toBe(rescheduleTo.toISOString());

      // Move delay to the past, then enqueue and confirm the transition persisted.
      await prisma.taskRun.update({
        where: { id: run.id },
        data: { delayUntil: new Date(Date.now() - 1_000) },
      });
      await engine.delayedRunSystem.enqueueDelayedRun({ runId: run.id });

      const afterEnqueue = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
      expect(afterEnqueue.status).toBe("PENDING");
    } finally {
      await engine.quit();
    }
  });

  heteroEngineTest(
    "far-future delayed run fires post-migration on the same worker, NO re-arm",
    async ({ prisma14, prisma17, redisOptions }) => {
      // A delayed run is born on the LEGACY DB (PG14) with a far-future delayUntil.
      // A straggler migration copies the run row and its latest snapshot onto the
      // NEW DB (PG17) and flips the residency map, WITHOUT re-arming any worker job.
      // The unchanged enqueueDelayedRun handler must resolve its reads/writes to the
      // NEW store (PG17), leaving the LEGACY copy untouched.

      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });

      // Residency table keyed by runId -> owning store. A real two-store router that
      // delegates every RunStore method to the resolved store. Methods with a runId
      // first arg resolve by it; bulk reads resolve by the first id; method without a
      // run id fall back to the default store.
      const residency = new Map<string, RunStore>();
      const router = createRouter(residency, legacyStore);

      // Seed env/worker/task on BOTH databases (control-plane resolver reads env via
      // the engine's prisma; the run-ops rows live on whichever store owns them).
      const env14 = await setupAuthenticatedEnvironment(prisma14, "PRODUCTION");
      const env17 = await setupAuthenticatedEnvironment(prisma17, "PRODUCTION");

      // The engine's prisma is PG17 (control plane / env resolution). Run-ops route
      // through the router.
      const engine = createEngine(prisma17, redisOptions, router);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env17, taskIdentifier);
        // Mirror a background worker + queue on PG14 so the legacy create is valid.
        await setupBackgroundWorker(engine14Proxy(engine, prisma14), env14, taskIdentifier);

        // Create a DELAYED run + latest snapshot directly on LEGACY (PG14) via the
        // legacy store, with a far-future delayUntil (+1 year). Residency: LEGACY.
        const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
        const created = await legacyStore.createRun(
          {
            data: {
              id: "run_hetero_delayed",
              engine: "V2",
              status: "DELAYED",
              friendlyId: "run_hd1",
              runtimeEnvironmentId: env14.id,
              environmentType: "PRODUCTION",
              organizationId: env14.organization.id,
              projectId: env14.project.id,
              taskIdentifier,
              payload: "{}",
              payloadType: "application/json",
              traceContext: {},
              traceId: "t_hd",
              spanId: "s_hd",
              queue: "task/test-task",
              workerQueue: "main",
              isTest: false,
              delayUntil: farFuture,
            },
            snapshot: {
              engine: "V2",
              executionStatus: "DELAYED",
              description: "Run was created with a delay",
              runStatus: "DELAYED",
              environmentId: env14.id,
              environmentType: "PRODUCTION",
              projectId: env14.project.id,
              organizationId: env14.organization.id,
            },
          },
          prisma14
        );
        residency.set(created.id, legacyStore);

        // Sanity: the run is DELAYED on LEGACY and absent on NEW.
        const legacyBefore = await prisma14.taskRun.findUnique({ where: { id: created.id } });
        expect(legacyBefore?.status).toBe("DELAYED");
        const newBefore = await prisma17.taskRun.findUnique({ where: { id: created.id } });
        expect(newBefore).toBeNull();

        // Simulate the straggler migration: copy the run row + its latest snapshot
        // onto NEW (PG17) and flip the residency map to NEW. NO worker re-arm.
        const latestSnapshot = await prisma14.taskRunExecutionSnapshot.findFirstOrThrow({
          where: { runId: created.id },
          orderBy: { createdAt: "desc" },
        });

        await prisma17.taskRun.create({
          data: {
            id: created.id,
            engine: "V2",
            status: "DELAYED",
            friendlyId: created.friendlyId,
            runtimeEnvironmentId: env17.id,
            environmentType: "PRODUCTION",
            organizationId: env17.organization.id,
            projectId: env17.project.id,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            traceContext: {},
            traceId: created.traceId,
            spanId: created.spanId,
            queue: "task/test-task",
            workerQueue: "main",
            isTest: false,
            // Move the deadline to the past on NEW so the (unchanged) handler enqueues.
            delayUntil: new Date(Date.now() - 1_000),
          },
        });

        await prisma17.taskRunExecutionSnapshot.create({
          data: {
            engine: "V2",
            executionStatus: latestSnapshot.executionStatus,
            description: latestSnapshot.description,
            runId: created.id,
            runStatus: latestSnapshot.runStatus,
            environmentId: env17.id,
            environmentType: "PRODUCTION",
            projectId: env17.project.id,
            organizationId: env17.organization.id,
            isValid: true,
          },
        });

        residency.set(created.id, newStore);

        // Fire the UNCHANGED handler. The router resolves the run to NEW.
        await engine.delayedRunSystem.enqueueDelayedRun({ runId: created.id });

        // Reads/writes resolved to NEW: status is now PENDING on PG17.
        const newAfter = await prisma17.taskRun.findUnique({ where: { id: created.id } });
        expect(newAfter?.status).toBe("PENDING");

        // LEGACY copy is untouched (still DELAYED with the far-future deadline).
        const legacyAfter = await prisma14.taskRun.findUnique({ where: { id: created.id } });
        expect(legacyAfter?.status).toBe("DELAYED");
        expect(legacyAfter?.delayUntil?.toISOString()).toBe(farFuture.toISOString());
      } finally {
        await engine.quit();
      }
    }
  );
});

// A minimal two-store router implementing RunStore by delegating each method to the
// store that OWNS the run id. Reads/writes that carry a runId first arg (or a bulk id
// list) resolve by residency; methods without a run id use the default store. This is
// a real router over real PostgresRunStores — no mocking.
export function createRouter(residency: Map<string, RunStore>, defaultStore: RunStore): RunStore {
  const resolveById = (runId: string): RunStore => residency.get(runId) ?? defaultStore;

  const handler: ProxyHandler<RunStore> = {
    get(_target, prop: string | symbol) {
      switch (prop) {
        // runId is the first positional arg.
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

        // findRun(where, ...) — resolve by where.id when present.
        case "findRun":
        case "findRunOrThrow":
          return (...args: any[]) => {
            const where = args[0];
            const id = where && typeof where.id === "string" ? where.id : undefined;
            const store = id ? resolveById(id) : defaultStore;
            return (store as any)[prop](...args);
          };

        // expireRunsBatch(runIds, ...) — resolve by the first id.
        case "expireRunsBatch":
          return (...args: any[]) => {
            const runIds: string[] = args[0] ?? [];
            const store = runIds.length > 0 ? resolveById(runIds[0]) : defaultStore;
            return (store as any)[prop](...args);
          };

        // findRuns({ where: { id: { in: [...] } } }) — resolve by the first id.
        case "findRuns":
          return (...args: any[]) => {
            const inList = args[0]?.where?.id?.in as string[] | undefined;
            const store = inList && inList.length > 0 ? resolveById(inList[0]) : defaultStore;
            return (store as any)[prop](...args);
          };

        default:
          // Everything else (createRun, waitpoint family, forWaitpointCompletion,
          // batch, checkpoint, attempt, dependency reads) goes to the default store.
          return (...args: any[]) => (defaultStore as any)[prop](...args);
      }
    },
  };

  return new Proxy({} as RunStore, handler);
}

// Tiny shim so setupBackgroundWorker can write its rows on the PG14 prisma using the
// engine's other facilities. setupBackgroundWorker only touches engine.prisma and
// engine.runQueue; we pass a view of the engine whose `prisma` is PG14.
function engine14Proxy(engine: RunEngine, prisma14: PrismaClient): RunEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === "prisma") return prisma14;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as RunEngine;
}
