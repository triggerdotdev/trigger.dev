// The connected-run gather now delegates to the injectable run store (findWaitpointConnectedRunIds +
// findRuns take:CONNECTED_RUNS_DISPLAY_LIMIT), which fans out over both DBs via $queryRaw and is
// BOUNDED inside the store — so the old per-client `taskRun.findMany` IN-list scan-limit assertion no
// longer describes the code (that store-level bound is covered by
// internal-packages/run-store/src/PostgresRunStore.connectedRunsBounded.test.ts). This test asserts
// the OUTPUT bound instead: seeding far more connections than the display limit, the presenter still
// returns at most CONNECTED_RUNS_DISPLAY_LIMIT connected-run friendlyIds. Exercises the dedicated
// `waitpointRunConnection` branch on the NEW run-ops client (prisma17), routed through a store wired
// to the per-test containers (NEW=dedicated prisma17, LEGACY=prisma14).
import { describe, expect, vi } from "vitest";

const legacyReplicaHolder = vi.hoisted(() => ({ client: undefined as any }));
const newClientHolder = vi.hoisted(() => ({ client: undefined as any }));

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  const lazyProxy = (holder: { client: any }, label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (!holder.client) {
            throw new Error(`${label} not set for this test`);
          }
          return holder.client[prop];
        },
      }
    );
  const replicaProxy = lazyProxy(legacyReplicaHolder, "legacyReplicaHolder.client");
  return {
    prisma: replicaProxy,
    $replica: replicaProxy,
    runOpsNewPrisma: lazyProxy(newClientHolder, "newClientHolder.client"),
    runOpsNewReplica: lazyProxy(newClientHolder, "newClientHolder.client"),
    runOpsLegacyPrisma: replicaProxy,
    runOpsLegacyReplica: replicaProxy,
    sqlDatabaseSchema: Prisma.sql([`public`]),
    DATABASE_SCHEMA: "public",
  };
});

vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: {
    getClickhouseForOrganization: async () => ({}),
  },
}));

// Echo the runId set back as runs so the presenter's final CH hydrate never runs for real -- the
// thing under test is the connected-run-id GATHER (the taskRun.findMany args), not this step.
vi.mock("~/presenters/v3/NextRunListPresenter.server", () => ({
  NextRunListPresenter: class {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(..._args: unknown[]) {}
    async call(_organizationId: string, _environmentId: string, opts: { runId?: string[] }) {
      return {
        runs: (opts.runId ?? []).map((friendlyId) => ({
          friendlyId,
          taskIdentifier: "echoed",
        })),
      };
    }
  },
}));

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import {
  CONNECTED_RUNS_CONNECTION_SCAN_LIMIT,
  CONNECTED_RUNS_DISPLAY_LIMIT,
  WaitpointPresenter,
} from "~/presenters/v3/WaitpointPresenter.server";

vi.setConfig({ testTimeout: 90_000 });

// Wire the presenter's run store to the test containers (NEW=dedicated prisma17, LEGACY=prisma14) so
// the connected-run gather routes to the containers instead of the default localhost:5432 store.
function makeRunStore(newClient: PrismaClient, legacyClient: PrismaClient) {
  return new RoutingRunStore({
    new: new PostgresRunStore({
      prisma: newClient as never,
      readOnlyPrisma: newClient as never,
      schemaVariant: "dedicated",
    }),
    legacy: new PostgresRunStore({
      prisma: legacyClient as never,
      readOnlyPrisma: legacyClient as never,
      schemaVariant: "legacy",
    }),
  });
}

type SeedContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

async function seedParents(prisma: PrismaClient, slug: string): Promise<SeedContext> {
  const organization = await prisma.organization.create({
    data: { title: `org-${slug}`, slug: `org-${slug}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: organization.id,
      externalRef: `proj-${slug}`,
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slug}`,
      pkApiKey: `pk_dev_${slug}`,
      shortcode: `sc-${slug}`,
    },
  });
  return {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: runtimeEnvironment.id,
  };
}

async function seedWaitpoint(
  prisma: PrismaClient | RunOpsPrismaClient,
  ctx: SeedContext,
  friendlyId: string
) {
  return (prisma as PrismaClient).waitpoint.create({
    data: {
      friendlyId,
      type: "MANUAL",
      status: "COMPLETED",
      idempotencyKey: `idem-${friendlyId}`,
      userProvidedIdempotencyKey: false,
      outputType: "application/json",
      outputIsError: false,
      completedAt: new Date(),
      tags: [],
      projectId: ctx.projectId,
      environmentId: ctx.environmentId,
    },
  });
}

async function seedRun(
  prisma: PrismaClient | RunOpsPrismaClient,
  ctx: SeedContext,
  friendlyId: string
) {
  return (prisma as PrismaClient).taskRun.create({
    data: {
      id: `run_${generateRunOpsId()}`,
      friendlyId,
      taskIdentifier: "my-task",
      status: "PENDING",
      payload: JSON.stringify({ foo: friendlyId }),
      payloadType: "application/json",
      traceId: friendlyId,
      spanId: friendlyId,
      queue: "test",
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
    },
  });
}

// Seed MORE than the scan limit (well above the display limit) so the output bound bites: an
// unbounded gather would surface every connection, a correctly bounded one caps the returned
// connected-run friendlyIds at CONNECTED_RUNS_DISPLAY_LIMIT.
const CONNECTED_RUN_COUNT = CONNECTED_RUNS_CONNECTION_SCAN_LIMIT + 5;

describe("WaitpointPresenter bounds the connected runs it returns", () => {
  heteroRunOpsPostgresTest(
    "a waitpoint with many more connections than the display limit returns at most the display limit",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "bounded");
      const waitpoint = await seedWaitpoint(prisma17, ctx, "waitpoint_bounded");

      const runs = await Promise.all(
        Array.from({ length: CONNECTED_RUN_COUNT }, (_, i) => seedRun(prisma17, ctx, `run_b${i}`))
      );
      for (const run of runs) {
        await prisma17.waitpointRunConnection.create({
          data: { taskRunId: run.id, waitpointId: waitpoint.id },
        });
      }

      legacyReplicaHolder.client = prisma14;
      newClientHolder.client = prisma17;

      // Route the gather through a store wired to the containers; without this it would fall through
      // to the default global store (localhost:5432) and fail in CI. NEW=prisma17 (dedicated) owns
      // the waitpoint + connections + runs; LEGACY=prisma14 holds the env parents.
      const presenter = new WaitpointPresenter(
        undefined,
        undefined,
        {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaClient,
          legacyReplica: prisma14,
        },
        makeRunStore(prisma17 as unknown as PrismaClient, prisma14 as unknown as PrismaClient)
      );

      const result = await presenter.call({
        friendlyId: waitpoint.friendlyId,
        environmentId: ctx.environmentId,
        projectId: ctx.projectId,
      });

      // OUTPUT bound: the waitpoint has CONNECTED_RUN_COUNT (> scan limit) connections, but the
      // presenter surfaces at most CONNECTED_RUNS_DISPLAY_LIMIT connected-run friendlyIds. The
      // NextRunListPresenter mock echoes the gathered runId set back verbatim, so
      // `result.connectedRuns` is exactly the (bounded) gather output. An unbounded gather would
      // return every connection here. The IN-list scan-limit bound now lives in the run store and is
      // covered by internal-packages/run-store/src/PostgresRunStore.connectedRunsBounded.test.ts.
      expect(result?.connectedRuns.length).toBe(CONNECTED_RUNS_DISPLAY_LIMIT);
      const friendlyIds = result?.connectedRuns.map((r) => r.friendlyId) ?? [];
      expect(new Set(friendlyIds).size).toBe(CONNECTED_RUNS_DISPLAY_LIMIT);
      for (const friendlyId of friendlyIds) {
        expect(friendlyId.startsWith("run_b")).toBe(true);
      }
    }
  );
});
