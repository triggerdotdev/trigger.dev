// Verifies findEnvironmentFromRun resolves a live, primary-resident run whose row has not yet
// replicated, so the runMetadataUpdated handler keeps the metadata write + realtime publish. Drives the
// REAL exported caller as the handler does (via $replica, no tx) over a real Postgres testcontainer with
// taskRun frozen "missing" on the replica; only the control-plane env resolver + db.server proxies are mocked.

import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Holders wired into the mocked db.server singletons before each call.
//   primaryHolder.client -> the real container (writer / owning primary).
//   replicaHolder.client -> a lagging replica over the SAME container: taskRun reads come back empty.
const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));
const replicaHolder = vi.hoisted(() => ({ client: undefined as any }));

// The env the (mocked) control-plane resolver returns, plus a record of the ids it was asked for, so
// the test can prove the caller reached the env-resolve with the run's real runtimeEnvironmentId.
const resolver = vi.hoisted(() => ({
  env: undefined as any,
  calls: [] as string[],
}));

// ~/db.server: point the two proxies the run-store singleton reads at our holders. Never mocks the DB
// itself — the proxies forward to real testcontainer clients. Run-ops split handles left undefined so
// runStore.server builds the single-DB passthrough store (writer = prisma, replica = $replica) — the
// exact webapp single-DB topology these reads run in.
vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  const lazyProxy = (holder: { client: any }, label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (!holder.client) throw new Error(`${label} not set for this test`);
          const value = holder.client[prop];
          // The run-store singleton memoizes each Prisma delegate on first access; re-resolve through
          // the holder so it always routes to the current test's client.
          if (value !== null && typeof value === "object") {
            return new Proxy(value, { get: (_d, method) => holder.client[prop][method] });
          }
          return value;
        },
      }
    );
  return {
    prisma: lazyProxy(primaryHolder, "primaryHolder.client"),
    $replica: lazyProxy(replicaHolder, "replicaHolder.client"),
    runOpsNewPrismaClient: undefined,
    runOpsNewReplicaClient: undefined,
    runOpsLegacyPrisma: undefined,
    runOpsLegacyReplica: undefined,
    sqlDatabaseSchema: Prisma.sql([`public`]),
  };
});

// Downstream env hydration is orthogonal to the run read under test: return a fixed env and record
// the environmentId it was asked to resolve. This is only reached when the run read succeeds, so it
// doubles as a witness that the caller got past the null-guard.
vi.mock("~/v3/runOpsMigration/controlPlaneResolver.server", () => ({
  controlPlaneResolver: {
    resolveAuthenticatedEnv: async (environmentId: string) => {
      resolver.calls.push(environmentId);
      return resolver.env;
    },
  },
}));

import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";
// The REAL exported caller under test.
import { findEnvironmentFromRun } from "~/models/runtimeEnvironment.server";

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
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_1",
      spanId: "span_1",
      runTags: ["alpha", "beta"],
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

describe("findEnvironmentFromRun resolves a primary-resident run under replica lag", () => {
  heteroPostgresTest(
    "a run not yet on the replica resolves via the primary re-read (non-null, keeping the metadata write)",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `envfromrun_${seq++}`;

      const seed = await seedTenant(prisma, suffix);

      // Seed the run on the PRIMARY (writer) only. The lagging replica will not see it.
      const runId = `run_${"e".repeat(21)}`;
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

      // A REAL lagging replica over the same container: taskRun reads miss; everything else forwards.
      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);

      primaryHolder.client = prisma;
      replicaHolder.client = replica.client;

      // The env the downstream resolver returns once the run is found.
      resolver.env = { id: seed.environment.id, __marker: "resolved-env" };
      resolver.calls.length = 0;

      // Drive the REAL exported caller exactly as the runMetadataUpdated handler does — no tx, so the
      // read routes to $replica (the lagging replica).
      const result = await findEnvironmentFromRun(runId);

      // The replica WAS consulted (the lag was really exercised on taskRun), yet the caller resolves
      // this live, primary-resident run to a non-null result.
      expect(replica.wasHit("taskRun")).toBe(true);
      expect(result).not.toBeNull();
      expect(result!.runTags).toEqual(["alpha", "beta"]);
      expect(result!.batchId).toBeNull();
      expect(result!.environment).toEqual(resolver.env);

      // The env-resolve was reached with the run's real runtimeEnvironmentId (past the null-guard).
      expect(resolver.calls).toEqual([seed.environment.id]);
    }
  );
});
