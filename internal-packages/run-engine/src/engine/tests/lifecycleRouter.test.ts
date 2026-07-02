import { containerTest, heteroPostgresTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { setTimeout } from "node:timers/promises";
import { describe, expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 120_000 });

function baseEngineOptions(redisOptions: any) {
  return {
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
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

const baseTriggerParams = (friendlyId: string, environment: any, taskIdentifier: string) => ({
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
  queue: `task/${taskIdentifier}`,
  isTest: false,
  tags: [] as string[],
});

/**
 * A real `PostgresRunStore` that records the snapshot-read and findRuns calls this
 * unit's lifecycle sites route through. NOT a mock — every override still issues the
 * real query via `super.*`; it only counts and records the forwarded read client so
 * the tests can prove the engine threaded `this.runStore` (and which client a read
 * was directed at). There is no `PassthroughRunStore` class to subclass — the single
 * `PostgresRunStore` IS the single-DB passthrough behavior.
 */
class CountingRunStore extends PostgresRunStore {
  label: string;
  latestSnapshotReads = 0;
  latestSnapshotRunIds: string[] = [];
  // The forwarded read client (positional arg index 1) for each snapshot read. Lets
  // the tests prove a routed read stayed on the primary and never fell to the replica.
  latestSnapshotClients: unknown[] = [];
  executionSnapshotReads = 0;
  executionSnapshotClients: unknown[] = [];
  manyExecutionSnapshotReads = 0;
  manyExecutionSnapshotClients: unknown[] = [];
  completedWaitpointReads = 0;
  findRunsCalls: Array<{ client: unknown }> = [];

  constructor(opts: { prisma: any; readOnlyPrisma: any; label?: string }) {
    super({ prisma: opts.prisma, readOnlyPrisma: opts.readOnlyPrisma });
    this.label = opts.label ?? "counting";
  }

  override findLatestExecutionSnapshot(...args: any[]) {
    this.latestSnapshotReads++;
    this.latestSnapshotRunIds.push(args[0]);
    this.latestSnapshotClients.push(args[1]);
    return (super.findLatestExecutionSnapshot as any)(...args);
  }

  override findExecutionSnapshot(...args: any[]) {
    this.executionSnapshotReads++;
    this.executionSnapshotClients.push(args[1]);
    return (super.findExecutionSnapshot as any)(...args);
  }

  override findManyExecutionSnapshots(...args: any[]) {
    this.manyExecutionSnapshotReads++;
    this.manyExecutionSnapshotClients.push(args[1]);
    return (super.findManyExecutionSnapshots as any)(...args);
  }

  override findSnapshotCompletedWaitpointIds(...args: any[]) {
    this.completedWaitpointReads++;
    return (super.findSnapshotCompletedWaitpointIds as any)(...args);
  }

  override findRuns(...args: any[]) {
    this.findRunsCalls.push({ client: args[1] });
    return (super.findRuns as any)(...args);
  }
}

describe("RunEngine lifecycle read routing (single-DB)", () => {
  // getRunExecutionData routes its latest-snapshot read through this.runStore
  // (the threaded getLatestExecutionSnapshot(prisma, runId, this.runStore) call).
  containerTest(
    "getRunExecutionData reads the latest snapshot through the store",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine({ prisma, store, ...baseEngineOptions(redisOptions) });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const friendlyId = generateFriendlyId("run");
        const run = await engine.trigger(
          baseTriggerParams(friendlyId, environment, taskIdentifier),
          prisma
        );

        const readsBefore = store.latestSnapshotReads;
        const data = await engine.getRunExecutionData({ runId: run.id });

        expect(data).not.toBeNull();
        expect(data!.run.id).toBe(run.id);
        expect(store.latestSnapshotReads).toBeGreaterThan(readsBefore);
        // Routed by owning run id (snapshots never route by snapshot id).
        expect(store.latestSnapshotRunIds).toContain(run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // getSnapshotsSince routes through the store's snapshot read methods (the
  // since-marker lookup, the page read, and the latest snapshot's waitpoint hydrate).
  containerTest("getSnapshotsSince reads through the store", async ({ prisma, redisOptions }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
    const engine = new RunEngine({ prisma, store, ...baseEngineOptions(redisOptions) });

    try {
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const run = await engine.trigger(
        baseTriggerParams(generateFriendlyId("run"), environment, taskIdentifier),
        prisma
      );

      await setTimeout(500);
      await engine.dequeueFromWorkerQueue({ consumerId: "test_since", workerQueue: "main" });

      const allSnapshots = await prisma.taskRunExecutionSnapshot.findMany({
        where: { runId: run.id, isValid: true },
        orderBy: { createdAt: "asc" },
      });
      expect(allSnapshots.length).toBeGreaterThan(1);

      const executionReadsBefore = store.executionSnapshotReads;
      const manyReadsBefore = store.manyExecutionSnapshotReads;

      const result = await engine.getSnapshotsSince({
        runId: run.id,
        snapshotId: allSnapshots[0].id,
      });

      expect(result).not.toBeNull();
      expect(result!.length).toBeGreaterThan(0);
      // The since-marker lookup + the page read both went through the store.
      expect(store.executionSnapshotReads).toBeGreaterThan(executionReadsBefore);
      expect(store.manyExecutionSnapshotReads).toBeGreaterThan(manyReadsBefore);
    } finally {
      await engine.quit();
    }
  });

  // With the replica-off default (readReplicaSnapshotsSinceEnabled unset),
  // getSnapshotsSince reads on the PRIMARY client. Distinct primary/replica-Proxy setup
  // proves both the since-marker (findExecutionSnapshot) and page (findManyExecutionSnapshots)
  // reads carried the primary handle and the replica was never touched.
  containerTest(
    "getSnapshotsSince reads on the primary client when the replica flag is off",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const primary = prisma;
      let replicaReads = 0;
      const replicaProxy = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === "taskRunExecutionSnapshot") {
            replicaReads++;
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as typeof prisma;

      const store = new CountingRunStore({ prisma: primary, readOnlyPrisma: replicaProxy });
      const engine = new RunEngine({ prisma: primary, store, ...baseEngineOptions(redisOptions) });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(
          baseTriggerParams(generateFriendlyId("run"), environment, taskIdentifier),
          primary
        );

        await setTimeout(500);
        await engine.dequeueFromWorkerQueue({ consumerId: "test_since_b2", workerQueue: "main" });

        const allSnapshots = await primary.taskRunExecutionSnapshot.findMany({
          where: { runId: run.id, isValid: true },
          orderBy: { createdAt: "asc" },
        });
        expect(allSnapshots.length).toBeGreaterThan(1);

        const result = await engine.getSnapshotsSince({
          runId: run.id,
          snapshotId: allSnapshots[0].id,
        });

        expect(result).not.toBeNull();
        // Both the since-marker and the page read carried the primary handle (default off)...
        expect(store.executionSnapshotClients.at(-1)).toBe(primary);
        expect(store.manyExecutionSnapshotClients.at(-1)).toBe(primary);
        // ...and the read-only (replica) handle was never accessed.
        expect(replicaReads).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  // The concurrency sweeper read goes through this.runStore.findRuns (already
  // routed on the baseline). The store's default findRuns read targets the read-only
  // client, so the sweeper scan stays off the primary without an explicit client arg.
  containerTest(
    "the sweeper reads finished runs through the store (default read client)",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine({ prisma, store, ...baseEngineOptions(redisOptions) });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(
          baseTriggerParams(generateFriendlyId("run"), environment, taskIdentifier),
          prisma
        );

        // Make it look like a run that finished more than the sweeper's offset ago.
        await prisma.taskRun.update({
          where: { id: run.id },
          data: {
            status: "COMPLETED_SUCCESSFULLY",
            completedAt: new Date(Date.now() - 1000 * 60 * 20),
          },
        });

        const callsBefore = store.findRunsCalls.length;
        // Drive the private sweeper callback through the run-queue wiring it is bound into.
        const callback = (engine as any).runQueue.options.concurrencySweeper.callback as (
          runIds: string[]
        ) => Promise<Array<{ id: string; orgId: string }>>;
        const found = await callback([run.id]);

        expect(store.findRunsCalls.length).toBeGreaterThan(callsBefore);
        expect(found).toEqual([{ id: run.id, orgId: environment.organization.id }]);
        // The default findRuns read carries no explicit client — it resolves to the
        // store's read-only client (the replica in a split deployment).
        expect(store.findRunsCalls.at(-1)!.client).toBeUndefined();
      } finally {
        await engine.quit();
      }
    }
  );

  // Single-DB binds one client (the `passthrough` field), proven BY BEHAVIOR.
  // A round-trip through the default-store engine returns exactly the snapshot just
  // written on the one configured client — no second DB/connection is configured. We
  // do NOT assert store.prisma === engine.prisma (the store exposes no such member).
  containerTest(
    "single-DB passthrough round-trip returns the snapshot just written",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      // No `store` injected → the engine defaults to a single PostgresRunStore over
      // the one prisma client (the passthrough single-DB behavior).
      const engine = new RunEngine({ prisma, ...baseEngineOptions(redisOptions) });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(
          baseTriggerParams(generateFriendlyId("run"), environment, taskIdentifier),
          prisma
        );

        const data = await engine.getRunExecutionData({ runId: run.id });
        expect(data).not.toBeNull();

        // The read returns exactly the latest snapshot persisted on the single client.
        const latest = await prisma.taskRunExecutionSnapshot.findFirst({
          where: { runId: run.id, isValid: true },
          orderBy: { createdAt: "desc" },
        });
        expect(latest).not.toBeNull();
        expect(data!.snapshot.id).toBe(latest!.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // getRunExecutionData's latest-snapshot read stays on the PRIMARY client.
  // The store resolves a routed read as `client ?? readOnlyPrisma`, so the only thing
  // keeping the engine off the replica is that it threads `this.prisma`. We give the
  // store distinct primary vs read-only handles (the read-only one a Proxy that counts
  // any `taskRunExecutionSnapshot` access, mirroring the read-through proof) and prove the read landed
  // on the primary and the replica was never touched.
  containerTest(
    "getRunExecutionData reads the latest snapshot on the primary client",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const primary = prisma;
      let replicaReads = 0;
      const replicaProxy = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === "taskRunExecutionSnapshot") {
            replicaReads++;
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as typeof prisma;

      const store = new CountingRunStore({ prisma: primary, readOnlyPrisma: replicaProxy });
      const engine = new RunEngine({ prisma: primary, store, ...baseEngineOptions(redisOptions) });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(
          baseTriggerParams(generateFriendlyId("run"), environment, taskIdentifier),
          primary
        );

        const data = await engine.getRunExecutionData({ runId: run.id });

        expect(data).not.toBeNull();
        expect(data!.run.id).toBe(run.id);
        // The routed latest-snapshot read carried the primary handle...
        expect(store.latestSnapshotClients.at(-1)).toBe(primary);
        // ...and the read-only (replica) handle was never accessed.
        expect(replicaReads).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  // The recovery path (#repairRun, driven via the public repairEnvironment)
  // also reads the latest snapshot on the PRIMARY client, never the replica. Same
  // distinct primary/replica-Proxy setup as the getRunExecutionData primary-read proof. A dequeued run holds environment
  // concurrency, so repairEnvironment's getCurrentConcurrencyOfEnvironment returns it;
  // dryRun=true keeps the path deterministic and enqueues no worker job.
  containerTest(
    "repairEnvironment reads the latest snapshot on the primary client",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const primary = prisma;
      let replicaReads = 0;
      const replicaProxy = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === "taskRunExecutionSnapshot") {
            replicaReads++;
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as typeof prisma;

      const store = new CountingRunStore({ prisma: primary, readOnlyPrisma: replicaProxy });
      const engine = new RunEngine({ prisma: primary, store, ...baseEngineOptions(redisOptions) });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(
          baseTriggerParams(generateFriendlyId("run"), environment, taskIdentifier),
          primary
        );

        // Dequeue so the run holds environment concurrency (otherwise the repair scan
        // finds no runIds to repair).
        await setTimeout(500);
        await engine.dequeueFromWorkerQueue({ consumerId: "test_repair", workerQueue: "main" });

        const concurrency = await (engine as any).runQueue.getCurrentConcurrencyOfEnvironment(
          environment
        );
        expect(concurrency).toContain(run.id);

        const readsBefore = store.latestSnapshotReads;
        await engine.repairEnvironment(environment, /* dryRun */ true);

        expect(store.latestSnapshotReads).toBeGreaterThan(readsBefore);
        expect(store.latestSnapshotRunIds).toContain(run.id);
        // The repair-path latest-snapshot read carried the primary handle...
        expect(store.latestSnapshotClients.at(-1)).toBe(primary);
        // ...and the read-only (replica) handle was never accessed.
        expect(replicaReads).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  // Two further latest-snapshot read sites — #handleStalledSnapshot (heartbeat-timeout)
  // and #handleRepairSnapshot (deferred repair job) — route through the same
  // primary-threaded getLatestExecutionSnapshot(this.prisma, ...) path proven above.
  // They are driven only by redis-worker timeout/repair jobs, so they are left
  // un-unit-covered here to avoid timing-dependent flakiness; the primary-routing
  // guarantee they share is established by the getRunExecutionData and repairEnvironment primary-read proofs above.
});

// ---------------------------------------------------------------------------
// Read-through / cross-version proofs (PG14 legacy <-> PG17 run-ops). These test
// the routing layer the engine's threaded reads delegate to: a real RoutingRunStore
// over two real PostgresRunStores on two real containers (NEVER mocked). A new run
// (ksuid id, born on PG17) resolves from the run-ops store; an old in-retention run
// (cuid id, on PG14) reads THROUGH the legacy store's read-only (replica) client.
// ---------------------------------------------------------------------------

// A cuid-length (25-char) internal id → classifies LEGACY; a ksuid-length (27-char)
// internal id → classifies NEW. The `run_` prefix is stripped before classification.
const legacyRunId = (suffix: string) => `run_${suffix.padEnd(25, "0").slice(0, 25)}`;
const newRunId = (suffix: string) => `run_${suffix.padEnd(27, "0").slice(0, 27)}`;

async function seedRunWithSnapshot(
  prisma: PrismaClient,
  runId: string,
  suffix: string
): Promise<{ snapshotId: string }> {
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
      type: "PRODUCTION",
      slug: `prod-${suffix}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
      maximumConcurrencyLimit: 10,
    },
  });

  await prisma.taskRun.create({
    data: {
      id: runId,
      engine: "V2",
      status: "EXECUTING",
      friendlyId: `friendly_${suffix}`,
      runtimeEnvironmentId: environment.id,
      organizationId: organization.id,
      projectId: project.id,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      queue: "task/test-task",
      traceId: `trace_${suffix}`,
      spanId: `span_${suffix}`,
    },
  });

  const snapshot = await prisma.taskRunExecutionSnapshot.create({
    data: {
      engine: "V2",
      executionStatus: "EXECUTING",
      description: `snapshot ${suffix}`,
      isValid: true,
      runId,
      runStatus: "EXECUTING",
      environmentId: environment.id,
      environmentType: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
    },
  });

  return { snapshotId: snapshot.id };
}

describe("RunEngine lifecycle read-through routing (PG14/PG17)", () => {
  // A NEW run (ksuid id) seeded only on the run-ops (PG17/new) store resolves
  // its latest snapshot from that store, and the legacy store is never touched.
  heteroPostgresTest(
    "a new run resolves its latest snapshot from the run-ops store",
    async ({ prisma14, prisma17 }) => {
      const newReadClient = prisma17 as unknown as PrismaClient;
      const legacyReadClient = prisma14 as unknown as PrismaClient;

      const newStore = new CountingRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: newReadClient,
        label: "new",
      });
      const legacyStore = new CountingRunStore({
        prisma: prisma14 as unknown as PrismaClient,
        readOnlyPrisma: legacyReadClient,
        label: "legacy",
      });
      const routing = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const runId = newRunId("new_run_e");
      const { snapshotId } = await seedRunWithSnapshot(
        prisma17 as unknown as PrismaClient,
        runId,
        "new_e"
      );

      const snapshot = await routing.findLatestExecutionSnapshot(runId);

      expect(snapshot).not.toBeNull();
      expect(snapshot!.id).toBe(snapshotId);
      // Resolved from the run-ops (new) store, never the legacy store.
      expect(newStore.latestSnapshotReads).toBe(1);
      expect(legacyStore.latestSnapshotReads).toBe(0);
    }
  );

  // An OLD run (cuid id) seeded only on the legacy (PG14) store reads through
  // the legacy store's read-only (replica) client — never the primary.
  heteroPostgresTest(
    "an old run reads through the legacy store's replica client",
    async ({ prisma14, prisma17 }) => {
      // Distinct primary vs read-only handles on the legacy side so we can prove the
      // read was directed at the read-only (replica) client, not the primary.
      const legacyPrimary = prisma14 as unknown as PrismaClient;
      let legacyReplicaReads = 0;
      const legacyReplica = new Proxy(prisma14 as unknown as PrismaClient, {
        get(target, prop, receiver) {
          if (prop === "taskRunExecutionSnapshot") {
            legacyReplicaReads++;
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as PrismaClient;

      const newStore = new CountingRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: prisma17 as unknown as PrismaClient,
        label: "new",
      });
      const legacyStore = new CountingRunStore({
        prisma: legacyPrimary,
        readOnlyPrisma: legacyReplica,
        label: "legacy",
      });
      const routing = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const runId = legacyRunId("old_run_f");
      const { snapshotId } = await seedRunWithSnapshot(legacyPrimary, runId, "old_f");

      const snapshot = await routing.findLatestExecutionSnapshot(runId);

      expect(snapshot).not.toBeNull();
      expect(snapshot!.id).toBe(snapshotId);
      // Read-through resolved on the legacy store...
      expect(legacyStore.latestSnapshotReads).toBe(1);
      expect(newStore.latestSnapshotReads).toBe(0);
      // ...via its read-only (replica) client, never the primary.
      expect(legacyReplicaReads).toBeGreaterThan(0);
    }
  );

  // The sweeper's findRuns scan across the routing store. The routing store's
  // findRuns ships the single-store (new) delegate today (the mixed-residency fan-out
  // is owned by the downstream routing-wire unit); this asserts the live behavior: the
  // scan reads through the run-ops (new) store's read-only client, off the primary.
  heteroPostgresTest(
    "the sweeper findRuns scan reads through the run-ops store",
    async ({ prisma14, prisma17 }) => {
      const newStore = new CountingRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: prisma17 as unknown as PrismaClient,
        label: "new",
      });
      const legacyStore = new CountingRunStore({
        prisma: prisma14 as unknown as PrismaClient,
        readOnlyPrisma: prisma14 as unknown as PrismaClient,
        label: "legacy",
      });
      const routing = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const newId = newRunId("new_run_g");
      await seedRunWithSnapshot(prisma17 as unknown as PrismaClient, newId, "new_g");
      await (prisma17 as unknown as PrismaClient).taskRun.update({
        where: { id: newId },
        data: {
          status: "COMPLETED_SUCCESSFULLY",
          completedAt: new Date(Date.now() - 1000 * 60 * 20),
        },
      });

      const runs = await routing.findRuns({
        where: {
          id: { in: [newId] },
          completedAt: { lte: new Date(Date.now() - 1000 * 60 * 10) },
          organizationId: { not: null },
          status: { in: ["COMPLETED_SUCCESSFULLY"] },
        },
        select: { id: true, status: true, organizationId: true },
      });

      expect(runs.map((r) => r.id)).toContain(newId);
      // The scan went through the run-ops (new) store's read-only client (no explicit
      // client passed → resolves to the store's read replica).
      expect(newStore.findRunsCalls.length).toBe(1);
      expect(newStore.findRunsCalls[0].client).toBeUndefined();
    }
  );
});
