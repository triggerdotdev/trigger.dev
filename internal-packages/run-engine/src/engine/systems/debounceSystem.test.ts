import { containerTest, heteroPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import { trace } from "@internal/tracing";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";
import { createTestSnapshot } from "../tests/helpers/snapshotTestHelpers.js";

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
    debounce: {
      maxDebounceDurationMs: 60_000,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

/**
 * A real PostgresRunStore subclass that counts the TaskRun read/write methods the debounce
 * existing-run path routes through, so the routing can be observed over real containers
 * without ever mocking prisma. super.* runs the genuine store implementation.
 */
class CountingPostgresRunStore extends PostgresRunStore {
  public findRunCalls = 0;
  public rewriteCalls = 0;
  public latestSnapshotReads = 0;
  public lastFindRunClients: unknown[] = [];

  override async findRun(...args: any[]): Promise<any> {
    this.findRunCalls++;
    // The trailing arg is the resolved client (`client?: ReadClient`) when present.
    this.lastFindRunClients.push(args[args.length - 1]);
    return (super.findRun as any)(...args);
  }

  override async rewriteDebouncedRun(
    ...args: Parameters<PostgresRunStore["rewriteDebouncedRun"]>
  ): ReturnType<PostgresRunStore["rewriteDebouncedRun"]> {
    this.rewriteCalls++;
    return super.rewriteDebouncedRun(...args);
  }

  override async findLatestExecutionSnapshot(
    ...args: Parameters<PostgresRunStore["findLatestExecutionSnapshot"]>
  ): ReturnType<PostgresRunStore["findLatestExecutionSnapshot"]> {
    this.latestSnapshotReads++;
    return super.findLatestExecutionSnapshot(...args);
  }
}

async function triggerDebouncedRun(
  engine: RunEngine,
  prisma: PrismaClient,
  environment: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>,
  taskIdentifier: string,
  opts: {
    delay?: string;
    delayUntilMs?: number;
    debounce: { key: string; delay: string; mode?: "leading" | "trailing"; updateData?: any };
    payload?: string;
  }
) {
  const friendlyId = RunId.generate().friendlyId;
  return engine.trigger(
    {
      number: 1,
      friendlyId,
      environment,
      taskIdentifier,
      payload: opts.payload ?? '{"data":"first"}',
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t_${friendlyId}`,
      spanId: `s_${friendlyId}`,
      workerQueue: "main",
      queue: "task/test-task",
      isTest: false,
      tags: [],
      delayUntil: new Date(Date.now() + (opts.delayUntilMs ?? 10_000)),
      debounce: opts.debounce,
    },
    prisma
  );
}

describe("debounceSystem store routing (single-DB passthrough)", () => {
  // The existing-run fast-path skip routes its reads through the store.
  containerTest(
    "existing-run fast-path skip routes its reads through the store",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const first = await triggerDebouncedRun(engine, prisma, environment, taskIdentifier, {
          debounce: { key: "fastpath-key", delay: "30s" },
          delayUntilMs: 30_000,
        });
        expect(first.status).toBe("DELAYED");

        const before = countingStore.findRunCalls;

        // A second trigger whose (quantized) delayUntil is not later than the existing
        // one takes the fast-path skip and returns the same existing run.
        const second = await triggerDebouncedRun(engine, prisma, environment, taskIdentifier, {
          debounce: { key: "fastpath-key", delay: "5s" },
          delayUntilMs: 5_000,
        });

        // Same run is returned (debounced onto the existing run id).
        expect(second.id).toBe(first.id);
        // The probe + full-run reads went through the store.
        expect(countingStore.findRunCalls).toBeGreaterThan(before);
      } finally {
        await engine.quit();
      }
    }
  );

  // The existing-run locked reschedule routes the re-read + the snapshot through
  // the store on the non-tx path (the snapshot read is this unit's one source edit, gated on
  // `tx ? undefined : this.$.runStore`). The public trigger path always supplies `tx: prisma`,
  // so the store-routed snapshot read is driven by calling handleDebounce without a tx.
  containerTest(
    "existing-run locked reschedule routes the re-read and snapshot through the store",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const first = await triggerDebouncedRun(engine, prisma, environment, taskIdentifier, {
          debounce: { key: "locked-key", delay: "10s" },
          delayUntilMs: 10_000,
        });
        expect(first.status).toBe("DELAYED");

        const firstRow = await prisma.taskRun.findFirstOrThrow({ where: { id: first.id } });
        const beforeFindRun = countingStore.findRunCalls;
        const beforeSnapshot = countingStore.latestSnapshotReads;

        // Drive handleDebounce directly with no tx so the snapshot read routes through the
        // store. A later delay pushes execution later, forcing the locked reschedule path
        // (#handleExistingRunLocked) rather than the fast-path skip.
        const result = await engine.debounceSystem.handleDebounce({
          environmentId: environment.id,
          taskIdentifier,
          debounce: { key: "locked-key", delay: "50s" },
          tx: undefined,
        });

        expect(result.status).toBe("existing");
        expect((result as any).run.id).toBe(first.id);
        expect((result as any).run.status).toBe("DELAYED");

        const rescheduledRow = await prisma.taskRun.findFirstOrThrow({ where: { id: first.id } });
        // The reschedule (delayedRunSystem) advanced delayUntil.
        expect(rescheduledRow.delayUntil!.getTime()).toBeGreaterThan(
          firstRow.delayUntil!.getTime()
        );
        // The locked re-read went through the store.
        expect(countingStore.findRunCalls).toBeGreaterThan(beforeFindRun);
        // The snapshot read in #handleExistingRunLocked routes through the store on the
        // non-tx path.
        expect(countingStore.latestSnapshotReads).toBeGreaterThan(beforeSnapshot);
      } finally {
        await engine.quit();
      }
    }
  );

  // Even on the tx path the snapshot read routes through the store.
  // getLatestExecutionSnapshot always passes this.$.runStore, so the read is routed to the
  // OWNING DB (correct for split mode — a ksuid run's snapshot lives on the dedicated DB, not the
  // caller's control-plane tx). Driving the locked reschedule inside a tx must still increment the
  // counting store's snapshot-read counter.
  containerTest(
    "existing-run locked reschedule on the tx path still routes the snapshot read through the store",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const first = await triggerDebouncedRun(engine, prisma, environment, taskIdentifier, {
          debounce: { key: "tx-snapshot-key", delay: "10s" },
          delayUntilMs: 10_000,
        });
        expect(first.status).toBe("DELAYED");

        const firstRow = await prisma.taskRun.findFirstOrThrow({ where: { id: first.id } });
        const beforeSnapshot = countingStore.latestSnapshotReads;

        // Drive handleDebounce inside a transaction, passing the tx. A later delay (50s vs the
        // existing 10s remaining) defeats the fast-path skip and reaches #handleExistingRunLocked,
        // whose snapshot read still routes through the store (owning-DB resolution).
        const result = await prisma.$transaction(async (tx) => {
          return await engine.debounceSystem.handleDebounce({
            environmentId: environment.id,
            taskIdentifier,
            debounce: { key: "tx-snapshot-key", delay: "50s" },
            tx: tx as any,
          });
        });

        expect(result.status).toBe("existing");
        expect((result as any).run.id).toBe(first.id);
        expect((result as any).run.status).toBe("DELAYED");

        const rescheduledRow = await prisma.taskRun.findFirstOrThrow({ where: { id: first.id } });
        // The reschedule advanced delayUntil.
        expect(rescheduledRow.delayUntil!.getTime()).toBeGreaterThan(
          firstRow.delayUntil!.getTime()
        );
        // The snapshot read routed through the store (owning-DB resolution), not the caller tx.
        expect(countingStore.latestSnapshotReads).toBeGreaterThan(beforeSnapshot);
      } finally {
        await engine.quit();
      }
    }
  );

  // Snapshot-read catch branch: when the snapshot read throws (run/snapshot gone),
  // #handleExistingRunLocked clears the stale Redis key and claims a fresh one, returning
  // status "new" instead of "existing".
  containerTest(
    "snapshot read failure clears the stale key and returns new",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const first = await triggerDebouncedRun(engine, prisma, environment, taskIdentifier, {
          debounce: { key: "snapshot-throw-key", delay: "10s" },
          delayUntilMs: 10_000,
        });
        expect(first.status).toBe("DELAYED");

        // Remove the run's snapshot rows so getLatestExecutionSnapshot throws
        // ("No execution snapshot found"), driving the catch branch.
        await prisma.taskRunExecutionSnapshot.deleteMany({ where: { runId: first.id } });

        // A later delay defeats the fast-path skip and reaches #handleExistingRunLocked, whose
        // snapshot read now throws.
        const result = await engine.debounceSystem.handleDebounce({
          environmentId: environment.id,
          taskIdentifier,
          debounce: { key: "snapshot-throw-key", delay: "50s" },
          tx: undefined,
        });

        // The stale existing run was abandoned; a fresh key was claimed for a new run.
        expect(result.status).toBe("new");
        expect((result as any).claimId).toBeDefined();
      } finally {
        await engine.quit();
      }
    }
  );

  // Non-DELAYED snapshot branch: when the latest snapshot's executionStatus is
  // neither DELAYED nor RUN_CREATED, #handleExistingRunLocked clears the Redis key and claims
  // a fresh one, returning status "new".
  containerTest(
    "non-delayed snapshot status clears the key and returns new",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const first = await triggerDebouncedRun(engine, prisma, environment, taskIdentifier, {
          debounce: { key: "non-delayed-key", delay: "10s" },
          delayUntilMs: 10_000,
        });
        expect(first.status).toBe("DELAYED");

        // Insert a newer valid snapshot whose executionStatus is EXECUTING. The snapshot read
        // (orderBy createdAt desc, isValid) now resolves a non-DELAYED/non-RUN_CREATED status.
        await createTestSnapshot(prisma, {
          runId: first.id,
          status: "EXECUTING",
          environmentId: environment.id,
          environmentType: environment.type,
          projectId: environment.project.id,
          organizationId: environment.organization.id,
        });

        // A later delay defeats the fast-path skip and reaches #handleExistingRunLocked, whose
        // snapshot status check now falls through to the claim-new path.
        const result = await engine.debounceSystem.handleDebounce({
          environmentId: environment.id,
          taskIdentifier,
          debounce: { key: "non-delayed-key", delay: "50s" },
          tx: undefined,
        });

        expect(result.status).toBe("new");
        expect((result as any).claimId).toBeDefined();
      } finally {
        await engine.quit();
      }
    }
  );

  // The trailing-mode update routes through the store via rewriteDebouncedRun.
  containerTest(
    "trailing-mode update routes through the store",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const first = await triggerDebouncedRun(engine, prisma, environment, taskIdentifier, {
          debounce: { key: "trailing-key", delay: "10s", mode: "trailing" },
          delayUntilMs: 10_000,
          payload: '{"data":"first"}',
        });
        expect(first.status).toBe("DELAYED");

        const before = countingStore.rewriteCalls;

        const second = await triggerDebouncedRun(engine, prisma, environment, taskIdentifier, {
          debounce: {
            key: "trailing-key",
            delay: "10s",
            mode: "trailing",
            updateData: { payload: '{"data":"updated"}', payloadType: "application/json" },
          },
          delayUntilMs: 10_000,
          payload: '{"data":"updated"}',
        });

        expect(second.id).toBe(first.id);
        // The trailing update went through rewriteDebouncedRun.
        expect(countingStore.rewriteCalls).toBeGreaterThan(before);

        const updatedRow = await prisma.taskRun.findFirstOrThrow({ where: { id: first.id } });
        expect(updatedRow.payload).toBe('{"data":"updated"}');
      } finally {
        await engine.quit();
      }
    }
  );

  // The lock-contention fallback routes its read through the store. A
  // LockAcquisitionTimeoutError-shaped failure from runLock drives
  // #handleLockContentionFallback, which reads the existing run via the store.
  containerTest(
    "lock-contention fallback routes its read through the store",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const first = await triggerDebouncedRun(engine, prisma, environment, taskIdentifier, {
          debounce: { key: "contention-key", delay: "10s" },
          delayUntilMs: 10_000,
        });
        expect(first.status).toBe("DELAYED");

        // Force a lock-contention error from runLock so handleExistingRun falls back.
        const runLock = (engine as any).runLock;
        const originalLock = runLock.lock.bind(runLock);
        runLock.lock = async (..._args: any[]) => {
          const err = new Error("simulated lock contention");
          err.name = "LockAcquisitionTimeoutError";
          throw err;
        };

        const before = countingStore.findRunCalls;
        let result: any;
        try {
          // Drive handleDebounce directly: fast-path is disabled by the later delay so the
          // path reaches the lock, which throws, triggering the contention fallback read.
          result = await engine.debounceSystem.handleDebounce({
            environmentId: environment.id,
            taskIdentifier,
            debounce: { key: "contention-key", delay: "50s" },
            tx: undefined,
          });
        } finally {
          runLock.lock = originalLock;
        }

        expect(result.status).toBe("existing");
        expect(result.run.id).toBe(first.id);
        // The fallback read went through the store.
        expect(countingStore.findRunCalls).toBeGreaterThan(before);
      } finally {
        await engine.quit();
      }
    }
  );

  // A caller-supplied tx is threaded through findRun's `client?` arg and honored,
  // not re-selected by the store.
  containerTest(
    "tx path is threaded straight through to the store read (honored, not re-routed)",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const first = await triggerDebouncedRun(engine, prisma, environment, taskIdentifier, {
          debounce: { key: "tx-key", delay: "10s" },
          delayUntilMs: 10_000,
        });
        expect(first.status).toBe("DELAYED");

        await prisma.$transaction(async (tx) => {
          countingStore.lastFindRunClients = [];
          const result = await engine.debounceSystem.handleDebounce({
            environmentId: environment.id,
            taskIdentifier,
            debounce: { key: "tx-key", delay: "5s" },
            tx: tx as any,
          });

          expect(result.status).toBe("existing");
          // Every store read in this call executed on the supplied tx client, not a
          // re-routed one.
          expect(countingStore.lastFindRunClients.length).toBeGreaterThan(0);
          for (const client of countingStore.lastFindRunClients) {
            expect(client).toBe(tx);
          }
        });
      } finally {
        await engine.quit();
      }
    }
  );

  // Single-DB binds one client (passthrough) — proven by behavior, not by reaching
  // into a private prisma member. The routed read returns exactly the row just written.
  containerTest(
    "single-DB binds one client (passthrough) — debounce round-trip on one client",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const first = await triggerDebouncedRun(engine, prisma, environment, taskIdentifier, {
          debounce: { key: "passthru-key", delay: "10s" },
          delayUntilMs: 10_000,
        });
        expect(first.status).toBe("DELAYED");

        // Push the run later through the locked reschedule path, then read it back through
        // the default-store engine — it resolves on the one client to exactly the row just
        // rescheduled.
        const second = await triggerDebouncedRun(engine, prisma, environment, taskIdentifier, {
          debounce: { key: "passthru-key", delay: "50s" },
          delayUntilMs: 50_000,
        });
        expect(second.id).toBe(first.id);

        const routed = await engine.runStore.findRun(
          { id: first.id },
          { include: { associatedWaitpoint: true } },
          prisma
        );
        const persisted = await prisma.taskRun.findFirstOrThrow({ where: { id: first.id } });

        expect(routed).not.toBeNull();
        expect(routed!.id).toBe(persisted.id);
        expect(routed!.delayUntil!.getTime()).toBe(persisted.delayUntil!.getTime());
      } finally {
        await engine.quit();
      }
    }
  );
});

// --- Cross-version read-through proof ---

/**
 * A real, minimal two-store router over two PostgresRunStore instances, selecting by owning
 * run id. Never a mock: it only re-implements the by-run-id route selection the production
 * RoutingRunStore performs, delegating to genuine stores over real containers. We know which
 * runs live where because we seed each run on exactly one store.
 */
class TwoStoreRunRouter {
  readonly newStore: PostgresRunStore;
  readonly legacyStore: PostgresRunStore;
  readonly #newRunIds: Set<string>;

  constructor(
    newStore: PostgresRunStore,
    legacyStore: PostgresRunStore,
    newRunIds: Iterable<string>
  ) {
    this.newStore = newStore;
    this.legacyStore = legacyStore;
    this.#newRunIds = new Set(newRunIds);
  }

  #route(runId: string): PostgresRunStore {
    return this.#newRunIds.has(runId) ? this.newStore : this.legacyStore;
  }

  findRun(where: any, ...rest: any[]) {
    return (this.#route(where.id).findRun as any)(where, ...rest);
  }
}

async function seedEnvironment(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { organization, project, environment };
}

async function seedDelayedRunWithWaitpoint(
  prisma: PrismaClient,
  store: PostgresRunStore,
  suffix: string,
  runId: string
) {
  const env = await seedEnvironment(prisma, suffix);
  const delayUntil = new Date("2024-06-01T00:00:00.000Z");
  const createdAt = new Date("2024-01-01T00:00:00.000Z");

  await store.createRun({
    data: {
      id: runId,
      engine: "V2",
      status: "DELAYED",
      friendlyId: `run_friendly_${suffix}`,
      runtimeEnvironmentId: env.environment.id,
      environmentType: "DEVELOPMENT",
      organizationId: env.organization.id,
      projectId: env.project.id,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${suffix}`,
      spanId: `span_${suffix}`,
      runTags: ["tag-a", "tag-b"],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      delayUntil,
      createdAt,
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "DELAYED",
      environmentId: env.environment.id,
      environmentType: "DEVELOPMENT",
      projectId: env.project.id,
      organizationId: env.organization.id,
    },
  } as any);

  // Attach an associated waitpoint so the `{ include: { associatedWaitpoint } }` read is exercised.
  await prisma.waitpoint.create({
    data: {
      type: "RUN",
      status: "PENDING",
      friendlyId: `waitpoint_${suffix}`,
      idempotencyKey: `wp_idem_${suffix}`,
      userProvidedIdempotencyKey: false,
      environmentId: env.environment.id,
      projectId: env.project.id,
      completedByTaskRunId: runId,
    },
  });

  return { env, delayUntil, createdAt };
}

describe("debounceSystem store routing (cross-version read-through)", () => {
  // An existing-run read round-trips deep-equal across PG14/PG17, routed by owning
  // run id (NEW=PG17 resolved, LEGACY=PG14 untouched for a NEW run).
  heteroPostgresTest(
    "existing-run read round-trips across versions, routed by run id",
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const rNew = "run_new_k";
      const rOld = "run_old_k";
      const seededNew = await seedDelayedRunWithWaitpoint(prisma17 as any, newStore, "new_k", rNew);
      const seededOld = await seedDelayedRunWithWaitpoint(
        prisma14 as any,
        legacyStore,
        "old_k",
        rOld
      );

      const router = new TwoStoreRunRouter(newStore, legacyStore, [rNew]);

      const newRun = await (router.findRun as any)(
        { id: rNew },
        { include: { associatedWaitpoint: true } },
        prisma17
      );
      const oldRun = await (router.findRun as any)(
        { id: rOld },
        { include: { associatedWaitpoint: true } },
        prisma14
      );

      // Routed by run id to the correct store; legacy untouched for the NEW run.
      const legacyRowForNew = await prisma14.taskRun.findFirst({ where: { id: rNew } });
      expect(legacyRowForNew).toBeNull();

      expect(newRun!.id).toBe(rNew);
      expect(oldRun!.id).toBe(rOld);

      // The read shape is identical across versions: status, delayUntil, createdAt,
      // runTags array, and the associatedWaitpoint include.
      expect(newRun!.status).toBe(oldRun!.status);
      expect(newRun!.status).toBe("DELAYED");
      expect(newRun!.delayUntil!.getTime()).toBe(seededNew.delayUntil.getTime());
      expect(oldRun!.delayUntil!.getTime()).toBe(seededOld.delayUntil.getTime());
      expect(newRun!.createdAt.getTime()).toBe(seededNew.createdAt.getTime());
      expect(newRun!.runTags).toEqual(oldRun!.runTags);
      expect(newRun!.runTags).toEqual(["tag-a", "tag-b"]);
      expect(newRun!.associatedWaitpoint).not.toBeNull();
      expect(oldRun!.associatedWaitpoint).not.toBeNull();
      expect(newRun!.associatedWaitpoint!.type).toBe(oldRun!.associatedWaitpoint!.type);
      expect(newRun!.associatedWaitpoint!.completedByTaskRunId).toBe(rNew);
      expect(oldRun!.associatedWaitpoint!.completedByTaskRunId).toBe(rOld);
    }
  );
});
