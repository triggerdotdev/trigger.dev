import { containerTest, heteroPostgresTest } from "@internal/testcontainers";
import {
  PostgresRunStore,
  type CreateExecutionSnapshotInput,
  type RunStore,
} from "@internal/run-store";
import { trace } from "@internal/tracing";
import { SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";
import { getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";

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
 * A real PostgresRunStore subclass that counts the snapshot read/write methods this unit
 * routes through, so the routing can be observed over real containers without ever mocking
 * prisma. super.* runs the genuine store implementation.
 */
class CountingPostgresRunStore extends PostgresRunStore {
  public creates = 0;
  public latestReads = 0;

  override async createExecutionSnapshot(
    input: CreateExecutionSnapshotInput,
    tx?: any
  ): ReturnType<PostgresRunStore["createExecutionSnapshot"]> {
    this.creates++;
    return super.createExecutionSnapshot(input, tx);
  }

  override async findLatestExecutionSnapshot(
    runId: string,
    client?: any
  ): ReturnType<PostgresRunStore["findLatestExecutionSnapshot"]> {
    this.latestReads++;
    return super.findLatestExecutionSnapshot(runId, client);
  }
}

async function triggerRun(engine: RunEngine, prisma: PrismaClient, friendlyId: string) {
  const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  const taskIdentifier = "test-task";
  await setupBackgroundWorker(engine, environment, taskIdentifier);

  const run = await engine.trigger(
    {
      number: 1,
      friendlyId,
      environment,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      workerQueue: "main",
      queue: "task/test-task",
      isTest: false,
      tags: [],
    },
    prisma
  );

  return run;
}

describe("executionSnapshotSystem store routing (single-DB passthrough)", () => {
  // A triggered run's first snapshot create goes through the store, and the row lands.
  containerTest("snapshot create routes through the store", async ({ prisma, redisOptions }) => {
    const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

    try {
      const run = await triggerRun(engine, prisma, "run_snapcreate1");

      const persisted = await prisma.taskRunExecutionSnapshot.findFirst({
        where: { runId: run.id },
      });
      expect(persisted).not.toBeNull();
      expect(persisted?.runId).toBe(run.id);
      expect(countingStore.creates).toBeGreaterThanOrEqual(1);
    } finally {
      await engine.quit();
    }
  });

  // getLatestExecutionSnapshot reads through the store, routed by run id.
  containerTest(
    "getLatestExecutionSnapshot reads through the store routed by run id",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const run = await triggerRun(engine, prisma, "run_snaplatest1");

        const before = countingStore.latestReads;
        const latest = await getLatestExecutionSnapshot(prisma, run.id, countingStore);

        expect(latest.runId).toBe(run.id);
        expect(countingStore.latestReads).toBeGreaterThan(before);
        // friendlyId is a valid SnapshotId friendly id derived from the cuid.
        expect(latest.friendlyId).toMatch(/^snapshot_/);
        expect(SnapshotId.fromFriendlyId(latest.friendlyId)).toBe(latest.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // Single-DB binds one client (passthrough) — proven by behavior, not by reaching
  // into a private prisma member. The read returns exactly the row just written.
  containerTest(
    "single-DB binds one client (passthrough) — round-trip on one client",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const run = await triggerRun(engine, prisma, "run_snappassthru");

        const latest = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
        const persisted = await prisma.taskRunExecutionSnapshot.findFirst({
          where: { runId: run.id, isValid: true },
          orderBy: { createdAt: "desc" },
        });

        expect(persisted).not.toBeNull();
        // The read resolves on the one client to exactly the row just written.
        expect(latest.id).toBe(persisted!.id);
        expect(latest.runId).toBe(run.id);
      } finally {
        await engine.quit();
      }
    }
  );
});

// --- Cross-version read-through proofs (Tests D/E/F) ---

/**
 * A real, minimal two-store router over two PostgresRunStore instances, selecting by owning
 * run id. Never a mock: it only re-implements the by-run-id #route selection the production
 * RoutingRunStore performs, delegating to genuine stores over real containers. We know which
 * runs live where because we seed each run on exactly one store.
 */
class TwoStoreSnapshotRouter {
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

  findLatestExecutionSnapshot(runId: string, client?: any) {
    return this.#route(runId).findLatestExecutionSnapshot(runId, client);
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

async function seedRunWithSnapshot(
  prisma: PrismaClient,
  store: PostgresRunStore,
  suffix: string,
  runId: string
) {
  const env = await seedEnvironment(prisma, suffix);
  await store.createRun({
    data: {
      id: runId,
      engine: "V2",
      status: "PENDING",
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
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: env.environment.id,
      environmentType: "DEVELOPMENT",
      projectId: env.project.id,
      organizationId: env.organization.id,
    },
  } as any);

  const snapshot = await store.createExecutionSnapshot({
    run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING", description: "executing" },
    environmentId: env.environment.id,
    environmentType: "DEVELOPMENT",
    projectId: env.project.id,
    organizationId: env.organization.id,
  });

  return { env, snapshot };
}

describe("executionSnapshotSystem store routing (cross-version read-through)", () => {
  // A new run resolves to the run-ops (NEW/PG17) store; the legacy store is untouched.
  heteroPostgresTest(
    "new run -> run-ops store (legacy untouched)",
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const rNew = "run_new_d";
      const { snapshot } = await seedRunWithSnapshot(prisma17 as any, newStore, "new_d", rNew);

      const router = new TwoStoreSnapshotRouter(newStore, legacyStore, [rNew]);

      const latest = await getLatestExecutionSnapshot(
        prisma17 as any,
        rNew,
        router as unknown as RunStore
      );

      expect(latest.runId).toBe(rNew);
      expect(latest.id).toBe(snapshot.id);
      // The legacy store has no such run.
      const legacyRow = await prisma14.taskRunExecutionSnapshot.findFirst({
        where: { runId: rNew },
      });
      expect(legacyRow).toBeNull();
    }
  );

  // An old run resolves via read-through to the LEGACY (PG14) store; the enhanced
  // snapshot is well-formed across the version boundary.
  heteroPostgresTest(
    "old run -> read-through to legacy store (well-formed across versions)",
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const rOld = "run_old_e";
      const { snapshot } = await seedRunWithSnapshot(prisma14 as any, legacyStore, "old_e", rOld);

      // rOld is NOT in the new-run set, so the router routes it to LEGACY (read-through).
      const router = new TwoStoreSnapshotRouter(newStore, legacyStore, []);

      const latest = await getLatestExecutionSnapshot(
        prisma14 as any,
        rOld,
        router as unknown as RunStore
      );

      expect(latest.runId).toBe(rOld);
      expect(latest.id).toBe(snapshot.id);
      // EnhancedExecutionSnapshot is well-formed: friendlyId/runFriendlyId derived, arrays present.
      expect(latest.friendlyId).toMatch(/^snapshot_/);
      expect(latest.runFriendlyId).toMatch(/^run_/);
      expect(Array.isArray(latest.completedWaitpoints)).toBe(true);
      expect(latest.checkpoint).toBeNull();
    }
  );

  // Routing keys off runId, the SnapshotId is a cuid (not a v1 run-ops id), and no
  // residency classifier is consulted for the snapshot id (D5).
  heteroPostgresTest(
    "snapshots route by owning run id; SnapshotId stays cuid",
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const rNew = "run_new_f";
      const { snapshot } = await seedRunWithSnapshot(prisma17 as any, newStore, "new_f", rNew);

      // cuid is 25 chars (c + 24); a v1 run-ops body is 26 chars ending in "1". The snapshot id is a cuid.
      expect(snapshot.id.length).toBe(25);

      const router = new TwoStoreSnapshotRouter(newStore, legacyStore, [rNew]);

      // Route succeeds purely via runId; the snapshot id is never classified.
      const latest = await getLatestExecutionSnapshot(
        prisma17 as any,
        rNew,
        router as unknown as RunStore
      );
      expect(latest.id).toBe(snapshot.id);
      expect(latest.id.length).toBe(25);
    }
  );
});
