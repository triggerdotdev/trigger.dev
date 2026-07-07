import { containerTest, heteroPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import { trace } from "@internal/tracing";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * A real lookup double standing in for the ClickHouse/control-plane candidate-id source.
 * Not a DB mock: it is the injected control-plane dependency that supplies candidate run ids,
 * exactly as the production CH-backed lookup does.
 */
class StubPendingVersionRunIdLookup {
  name = "stub-lookup";
  constructor(private ids: string[]) {}
  setIds(ids: string[]) {
    this.ids = ids;
  }
  async lookupPendingVersionRunIds(_args: any): Promise<{ runIds: string[] }> {
    return { runIds: this.ids };
  }
}

/**
 * A real PostgresRunStore subclass that counts the run-ops methods the pendingVersion path
 * routes through, so the routing can be observed over real containers without mocking prisma.
 */
class CountingPostgresRunStore extends PostgresRunStore {
  public findRunsCalls = 0;
  public promoteCalls = 0;
  public promotedIds: string[] = [];

  /**
   * Optional side-effect run AFTER `findRuns` has hydrated its rows but BEFORE
   * they are returned to the caller. Used to simulate a candidate that is still
   * PENDING_VERSION at hydrate time but races out of it before the per-run
   * promote transaction runs, so the loop reaches it and the count === 0
   * idempotency guard fires.
   */
  public afterFindRuns?: () => Promise<void>;

  override async findRuns(
    ...args: Parameters<PostgresRunStore["findRuns"]>
  ): ReturnType<PostgresRunStore["findRuns"]> {
    this.findRunsCalls++;
    const result = await super.findRuns(...args);
    if (this.afterFindRuns) {
      await this.afterFindRuns();
    }
    return result;
  }

  override async promotePendingVersionRuns(
    ...args: Parameters<PostgresRunStore["promotePendingVersionRuns"]>
  ): ReturnType<PostgresRunStore["promotePendingVersionRuns"]> {
    this.promoteCalls++;
    this.promotedIds.push(args[0] as string);
    return super.promotePendingVersionRuns(...args);
  }
}

function createEngineOptions(
  redisOptions: any,
  prisma: any,
  lookup: StubPendingVersionRunIdLookup,
  store?: PostgresRunStore
) {
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
    pendingVersionRunIdLookup: lookup,
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

/**
 * Seed a PENDING_VERSION run via the store directly into the given environment. This avoids the
 * trigger lifecycle's background auto-resolution racing the test, while still exercising the
 * real run-ops store create path over real containers.
 */
async function seedPendingVersionRunInEnv(
  store: PostgresRunStore,
  environment: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>,
  taskIdentifier: string,
  createdAt: Date = new Date()
) {
  const { id, friendlyId } = RunId.generate();
  await store.createRun({
    data: {
      id,
      engine: "V2",
      status: "PENDING_VERSION",
      friendlyId,
      runtimeEnvironmentId: environment.id,
      environmentType: environment.type,
      organizationId: environment.organizationId,
      projectId: environment.projectId,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${friendlyId}`,
      spanId: `span_${friendlyId}`,
      runTags: [],
      queue: `task/${taskIdentifier}`,
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt,
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING_VERSION",
      environmentId: environment.id,
      environmentType: environment.type,
      projectId: environment.projectId,
      organizationId: environment.organizationId,
    },
  } as any);
  return { id, queue: `task/${taskIdentifier}` };
}

describe("pendingVersionSystem store routing (single-DB passthrough)", () => {
  // Candidate ids from the (control-plane/CH) lookup hydrate from the run-ops store
  // via findRuns. Uses a DEVELOPMENT env so setupBackgroundWorker performs no deployment +
  // no background auto-resolution that would race the manual resolve.
  containerTest(
    "CH candidate ids hydrate from the run-ops store via findRuns",
    async ({ prisma, redisOptions }) => {
      const lookup = new StubPendingVersionRunIdLookup([]);
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(
        createEngineOptions(redisOptions, prisma, lookup, countingStore)
      );

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "DEVELOPMENT");
        const taskIdentifier = "test-task";
        const worker = await setupBackgroundWorker(engine, environment, taskIdentifier);

        const r1 = await seedPendingVersionRunInEnv(countingStore, environment, taskIdentifier);
        const r2 = await seedPendingVersionRunInEnv(countingStore, environment, taskIdentifier);

        lookup.setIds([r1.id, r2.id]);

        const beforeFindRuns = countingStore.findRunsCalls;
        await engine.pendingVersionSystem.enqueueRunsForBackgroundWorker(worker.worker.id);

        // The id-set hydrate went through findRuns.
        expect(countingStore.findRunsCalls).toBeGreaterThan(beforeFindRuns);
        // Both candidate rows were promoted out of PENDING_VERSION via the routed flip.
        const after = await prisma.taskRun.findMany({ where: { id: { in: [r1.id, r2.id] } } });
        for (const row of after) expect(row.status).toBe("PENDING");
      } finally {
        await engine.quit();
      }
    }
  );

  // The promotion flips PENDING_VERSION -> PENDING atomically and enqueues; the
  // count === 0 idempotency guard fires for a candidate that is still PENDING_VERSION at
  // hydrate time but races out of it before its per-run promote transaction runs. r2 is
  // flipped to PENDING by the store's afterFindRuns hook — i.e. AFTER findRuns has already
  // hydrated it into the candidate set — so the loop reaches r2, promotePendingVersionRuns
  // is genuinely invoked for it, returns count === 0, and the `if (!promoted) continue`
  // guard skips the enqueue/event without throwing.
  containerTest(
    "promotion flips PENDING_VERSION -> PENDING atomically; count === 0 guard skips a raced candidate",
    async ({ prisma, redisOptions }) => {
      const lookup = new StubPendingVersionRunIdLookup([]);
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(
        createEngineOptions(redisOptions, prisma, lookup, countingStore)
      );

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "DEVELOPMENT");
        const taskIdentifier = "test-task";
        const worker = await setupBackgroundWorker(engine, environment, taskIdentifier);

        const r1 = await seedPendingVersionRunInEnv(countingStore, environment, taskIdentifier);
        const r2 = await seedPendingVersionRunInEnv(countingStore, environment, taskIdentifier);

        const statusEvents: string[] = [];
        engine.eventBus.on("runStatusChanged", (e: any) => {
          statusEvents.push(e.run.id);
        });

        // Both r1 and r2 are PENDING_VERSION when findRuns hydrates them. Right after the
        // hydrate returns, flip r2 to PENDING so that when the per-run loop reaches it the
        // promote update matches 0 rows. This drives the count === 0 branch — unlike a
        // pre-call flip, which would have r2 dropped by the hydrate status filter and never
        // reach the promote at all. Guard against re-entrancy (findRuns may run again on a
        // reschedule) so we only flip once.
        let flipped = false;
        countingStore.afterFindRuns = async () => {
          if (flipped) return;
          flipped = true;
          await prisma.taskRun.update({ where: { id: r2.id }, data: { status: "PENDING" } });
        };

        lookup.setIds([r1.id, r2.id]);
        await engine.pendingVersionSystem.enqueueRunsForBackgroundWorker(worker.worker.id);

        // The guard was actually reached for r2 (it survived the hydrate), not skipped earlier.
        expect(countingStore.promotedIds).toContain(r2.id);
        expect(countingStore.promotedIds).toContain(r1.id);

        const after = await prisma.taskRun.findMany({ where: { id: { in: [r1.id, r2.id] } } });
        const byId = new Map(after.map((r) => [r.id, r]));
        // r1 was promoted PENDING_VERSION -> PENDING.
        expect(byId.get(r1.id)!.status).toBe("PENDING");
        // r2 stays PENDING (the count === 0 guard skipped it, no double-promote, no throw).
        expect(byId.get(r2.id)!.status).toBe("PENDING");

        // r1 entered the queue.
        const queueLength = await engine.runQueue.lengthOfQueue(environment, r1.queue);
        expect(queueLength).toBeGreaterThanOrEqual(1);

        // A runStatusChanged event fired for the promoted run only; r2 was skipped.
        expect(statusEvents).toContain(r1.id);
        expect(statusEvents).not.toContain(r2.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // Candidate ids whose rows are no longer PENDING_VERSION are dropped by the hydrate
  // and no promotion/enqueue fires.
  containerTest(
    "stale candidates (not PENDING_VERSION) are dropped by the hydrate",
    async ({ prisma, redisOptions }) => {
      const lookup = new StubPendingVersionRunIdLookup([]);
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(
        createEngineOptions(redisOptions, prisma, lookup, countingStore)
      );

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "DEVELOPMENT");
        const taskIdentifier = "test-task";
        const worker = await setupBackgroundWorker(engine, environment, taskIdentifier);

        const r1 = await seedPendingVersionRunInEnv(countingStore, environment, taskIdentifier);

        // Move it past PENDING_VERSION so the residual status filter drops it.
        await prisma.taskRun.update({ where: { id: r1.id }, data: { status: "PENDING" } });

        lookup.setIds([r1.id]);

        const beforePromote = countingStore.promoteCalls;
        await engine.pendingVersionSystem.enqueueRunsForBackgroundWorker(worker.worker.id);

        // Hydrate ran but found nothing PENDING_VERSION, so no promotion fired.
        expect(countingStore.findRunsCalls).toBeGreaterThanOrEqual(1);
        expect(countingStore.promoteCalls).toBe(beforePromote);
      } finally {
        await engine.quit();
      }
    }
  );

  // Single-DB binds one client (passthrough) — proven by behavior. The whole resolve
  // cycle (hydrate + flip + enqueue) resolves on the one client.
  containerTest(
    "single-DB binds one client (passthrough) — full resolve cycle on one client",
    async ({ prisma, redisOptions }) => {
      const lookup = new StubPendingVersionRunIdLookup([]);
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, lookup));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "DEVELOPMENT");
        const taskIdentifier = "test-task";
        const worker = await setupBackgroundWorker(engine, environment, taskIdentifier);

        const r1 = await seedPendingVersionRunInEnv(
          engine.runStore as PostgresRunStore,
          environment,
          taskIdentifier
        );

        lookup.setIds([r1.id]);
        await engine.pendingVersionSystem.enqueueRunsForBackgroundWorker(worker.worker.id);

        // The flipped row and the enqueue resolve on the one client.
        const row = await prisma.taskRun.findFirstOrThrow({ where: { id: r1.id } });
        expect(row.status).toBe("PENDING");
        const queueLength = await engine.runQueue.lengthOfQueue(environment, r1.queue);
        expect(queueLength).toBeGreaterThanOrEqual(1);
      } finally {
        await engine.quit();
      }
    }
  );
});

// --- Cross-version / cross-DB proofs (Tests L/M) ---

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

async function seedPendingVersionRun(
  prisma: PrismaClient,
  store: PostgresRunStore,
  suffix: string,
  runId: string,
  createdAt: Date,
  env: Awaited<ReturnType<typeof seedEnvironment>>
) {
  await store.createRun({
    data: {
      id: runId,
      engine: "V2",
      status: "PENDING_VERSION",
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
      runTags: [],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt,
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING_VERSION",
      environmentId: env.environment.id,
      environmentType: "DEVELOPMENT",
      projectId: env.project.id,
      organizationId: env.organization.id,
    },
  } as any);
}

describe("pendingVersionSystem store routing (cross-version / cross-DB)", () => {
  // Hydrate + promotion round-trip identically across PG14/PG17.
  heteroPostgresTest(
    "hydrate + promotion round-trip across versions",
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const envNew = await seedEnvironment(prisma17 as any, "new_l");
      const envOld = await seedEnvironment(prisma14 as any, "old_l");

      const newIds = ["run_new_l1", "run_new_l2"];
      const oldIds = ["run_old_l1", "run_old_l2"];
      // Seed in reverse createdAt order to prove the createdAt-asc ORDER BY.
      await seedPendingVersionRun(
        prisma17 as any,
        newStore,
        "new_l2",
        newIds[1],
        new Date("2024-02-01T00:00:00.000Z"),
        envNew
      );
      await seedPendingVersionRun(
        prisma17 as any,
        newStore,
        "new_l1",
        newIds[0],
        new Date("2024-01-01T00:00:00.000Z"),
        envNew
      );
      await seedPendingVersionRun(
        prisma14 as any,
        legacyStore,
        "old_l2",
        oldIds[1],
        new Date("2024-02-01T00:00:00.000Z"),
        envOld
      );
      await seedPendingVersionRun(
        prisma14 as any,
        legacyStore,
        "old_l1",
        oldIds[0],
        new Date("2024-01-01T00:00:00.000Z"),
        envOld
      );

      const newHydrate = await newStore.findRuns(
        { where: { id: { in: newIds }, status: "PENDING_VERSION" }, orderBy: { createdAt: "asc" } },
        prisma17 as any
      );
      const oldHydrate = await legacyStore.findRuns(
        { where: { id: { in: oldIds }, status: "PENDING_VERSION" }, orderBy: { createdAt: "asc" } },
        prisma14 as any
      );

      // Identical ORDER BY (createdAt asc) across versions.
      expect(newHydrate.map((r) => r.friendlyId.replace("new_", ""))).toEqual(
        oldHydrate.map((r) => r.friendlyId.replace("old_", ""))
      );
      expect(newHydrate.map((r) => r.id)).toEqual(newIds);
      expect(oldHydrate.map((r) => r.id)).toEqual(oldIds);

      // Promotion flips identically across versions.
      const newPromote = await newStore.promotePendingVersionRuns(newIds[0], prisma17 as any);
      const oldPromote = await legacyStore.promotePendingVersionRuns(oldIds[0], prisma14 as any);
      expect(newPromote.count).toBe(oldPromote.count);
      expect(newPromote.count).toBe(1);

      const newReread = await newStore.findRunOrThrow({ id: newIds[0] }, prisma17 as any);
      const oldReread = await legacyStore.findRunOrThrow({ id: oldIds[0] }, prisma14 as any);
      expect(newReread.status).toBe(oldReread.status);
      expect(newReread.status).toBe("PENDING");
    }
  );

  // Cross-DB seam — lookup ids resolve to the NEW store; the promotion lands on NEW
  // only, the LEGACY store is untouched.
  heteroPostgresTest(
    "cross-DB seam: CH ids resolve + promote on the NEW store only",
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const envNew = await seedEnvironment(prisma17 as any, "new_m");
      const envOld = await seedEnvironment(prisma14 as any, "old_m");

      const newId = "run_new_m";
      const legacyId = "run_legacy_m";
      await seedPendingVersionRun(
        prisma17 as any,
        newStore,
        "new_m",
        newId,
        new Date("2024-01-01T00:00:00.000Z"),
        envNew
      );
      await seedPendingVersionRun(
        prisma14 as any,
        legacyStore,
        "old_m",
        legacyId,
        new Date("2024-01-01T00:00:00.000Z"),
        envOld
      );

      // The candidate id from the lookup exists on the NEW store. Hydrate it from NEW only.
      const hydrated = await newStore.findRuns(
        {
          where: { id: { in: [newId] }, status: "PENDING_VERSION" },
          orderBy: { createdAt: "asc" },
        },
        prisma17 as any
      );
      expect(hydrated.map((r) => r.id)).toEqual([newId]);

      // Promote on NEW.
      const promote = await newStore.promotePendingVersionRuns(newId, prisma17 as any);
      expect(promote.count).toBe(1);

      // NEW flipped; LEGACY row untouched.
      const newRow = await prisma17.taskRun.findFirstOrThrow({ where: { id: newId } });
      expect(newRow.status).toBe("PENDING");
      const legacyRow = await prisma14.taskRun.findFirstOrThrow({ where: { id: legacyId } });
      expect(legacyRow.status).toBe("PENDING_VERSION");
      // The NEW id does not exist on LEGACY at all.
      const newOnLegacy = await prisma14.taskRun.findFirst({ where: { id: newId } });
      expect(newOnLegacy).toBeNull();
    }
  );
});
