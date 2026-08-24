// Replica-lag properties for engine-adjacent webapp reads. Each case drives the REAL exported caller
// (resolveRunForMutation, resolveRunCommit) through a real PostgresRunStore whose owning replica is
// FROZEN via the shared `laggingReplica` primitive; only orthogonal collaborators are mocked.

import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ---------------------------------------------------------------------------------------------------
// Module singletons the webapp-service callers close over. Filled per-test; a stable Proxy keeps the
// named import binding constant while forwarding to the per-test client/store.
// ---------------------------------------------------------------------------------------------------
const H = vi.hoisted(() => {
  const proxyTo = (get: () => any, label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          const target = get();
          if (!target) throw new Error(`${label} not set for this test`);
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      }
    );
  return {
    dbHolder: { primary: undefined as any, replica: undefined as any },
    storeHolder: { store: undefined as any },
    proxyTo,
  };
});
const { dbHolder, storeHolder } = H;

vi.mock("~/db.server", () => ({
  prisma: H.proxyTo(() => H.dbHolder.primary, "dbHolder.primary"),
  $replica: H.proxyTo(() => H.dbHolder.replica, "dbHolder.replica"),
}));

vi.mock("~/v3/runStore.server", () => ({
  runStore: H.proxyTo(() => H.storeHolder.store, "storeHolder.store"),
}));

// The buffer is orthogonal to resolveRunForMutation; force a clean miss so the only recovery path is
// the writer probe under test.
vi.mock("~/v3/mollifier/mollifierBuffer.server", () => ({
  getMollifierBuffer: () => null,
}));

// dashboardAgent.server pulls a heavy import graph (SDK, GitHub app, rbac) at module load that is
// entirely orthogonal to the findRun under test — stub those leaves so the module imports cleanly.
vi.mock("~/env.server", () => ({
  env: { API_ORIGIN: "https://api.local", APP_ORIGIN: "https://app.local" },
}));
vi.mock("~/services/gitHub.server", () => ({ githubApp: {} }));
vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@trigger.dev/rbac", () => ({ signUserActorToken: vi.fn() }));
vi.mock("@trigger.dev/sdk", () => ({ TriggerClient: class {} }));
vi.mock("@trigger.dev/sdk/ai", () => ({ chat: {} }));

// The REAL callers under guard.
import { resolveRunForMutation } from "~/v3/mollifier/resolveRunForMutation.server";
import { resolveRunCommit } from "~/services/dashboardAgent.server";

let seq = 0;

async function seedTenant(prisma: PrismaClient, suffix: string) {
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

function buildCreateRunInput(p: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  lockedToVersionId?: string;
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: p.friendlyId,
      runtimeEnvironmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: p.organizationId,
      projectId: p.projectId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      lockedToVersionId: p.lockedToVersionId,
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_1",
      spanId: "span_1",
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
      environmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: p.projectId,
      organizationId: p.organizationId,
    },
  };
}

afterEach(() => {
  dbHolder.primary = undefined;
  dbHolder.replica = undefined;
  storeHolder.store = undefined;
});

// ===================================================================================================
// resolveRunForMutation findRun — a replica miss is recovered by the writer probe. Driving the REAL
// exported resolveRunForMutation under a frozen replica returns {source:"pg"} via the writer probe,
// with the replica genuinely consulted first.
// ===================================================================================================
describe("resolveRunForMutation — replica lag", () => {
  heteroPostgresTest(
    "a live run absent on the replica is recovered via the writer probe (source: pg)",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `rrfm_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const runId = `run_${"a".repeat(21)}`;
      const friendlyId = `run_${suffix}`;
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      // The runStore singleton the caller reads through: writer=primary, replica used only via the
      // client the caller threads. We route findRun's client explicitly through db.server handles.
      storeHolder.store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      dbHolder.primary = prisma;
      dbHolder.replica = replica.client;

      const result = await resolveRunForMutation({
        runParam: friendlyId,
        environmentId: seed.environment.id,
        organizationId: seed.organization.id,
      });

      // The replica was consulted first (read-your-writes hazard genuinely exercised)...
      expect(replica.wasHit("taskRun")).toBe(true);
      // ...and the writer probe recovered the live run.
      expect(result).not.toBeNull();
      expect(result?.source).toBe("pg");
      expect(result?.friendlyId).toBe(friendlyId);
    }
  );

  heteroPostgresTest(
    "a genuinely absent run still resolves to null (writer probe misses too)",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `rrfm_absent_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      storeHolder.store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      dbHolder.primary = prisma;
      dbHolder.replica = replica.client;

      const result = await resolveRunForMutation({
        runParam: "run_does_not_exist",
        environmentId: seed.environment.id,
        organizationId: seed.organization.id,
      });
      expect(result).toBeNull();
    }
  );
});

// ===================================================================================================
// resolveRunCommit findRun — a live pinned run resolves its commit via the owning PRIMARY
// (findRunOnPrimary), so the frozen replica is never consulted. Routing this read to the replica would
// miss the row and return null, silently falling back to the branch head on a LIVE deployed+pinned run.
// ===================================================================================================
describe("resolveRunCommit — replica lag", () => {
  heteroPostgresTest(
    "a live pinned run resolves its commit via the primary",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `rrc_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      // A deployed BackgroundWorker + WorkerDeployment carrying the commit the run is pinned to.
      const worker = await prisma.backgroundWorker.create({
        data: {
          friendlyId: `worker_${suffix}`,
          contentHash: `hash_${suffix}`,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          version: "20240101.1",
          metadata: {},
        },
      });
      await prisma.workerDeployment.create({
        data: {
          friendlyId: `deployment_${suffix}`,
          contentHash: `hash_${suffix}`,
          version: "20240101.1",
          shortCode: `sc_${suffix}`,
          projectId: seed.project.id,
          environmentId: seed.environment.id,
          workerId: worker.id,
          commitSHA: "deadbeefcafe",
          git: { dirty: false },
        },
      });

      const runId = `run_${"b".repeat(21)}`;
      const friendlyId = `run_${suffix}`;
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          lockedToVersionId: worker.id,
        })
      );

      // The store the caller reads through: its REPLICA is frozen (row not visible), primary is live.
      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      storeHolder.store = new PostgresRunStore({ prisma, readOnlyPrisma: replica.client });
      dbHolder.primary = prisma;
      dbHolder.replica = replica.client;

      const result = await resolveRunCommit(seed.environment.id, friendlyId);

      // The read routes to the owning PRIMARY (findRunOnPrimary), so the frozen replica is never
      // consulted, and the live pinned run + its deployment commit resolve.
      expect(replica.wasHit("taskRun")).toBe(false);
      expect(result).not.toBeNull();
      expect(result?.sha).toBe("deadbeefcafe");
      expect(result?.version).toBe("20240101.1");
      expect(result?.dirty).toBe(false);
    }
  );
});
