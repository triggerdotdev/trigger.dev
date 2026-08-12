// RED->GREEN guard: #connectedRunIdsOn used to cap the connection-id fetch at
// CONNECTED_RUNS_DISPLAY_LIMIT BEFORE checking the runs exist. The dedicated store's
// WaitpointRunConnection is FK-free, so dangling rows can starve out real ones within the cap.
// The fix existence-filters AT THE QUERY (JOIN to TaskRun) so the LIMIT only ever lands on rows
// whose run exists.
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

async function seedWaitpoint(prisma: RunOpsPrismaClient, ctx: SeedContext, friendlyId: string) {
  return (prisma as unknown as PrismaClient).waitpoint.create({
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

async function seedRun(prisma: RunOpsPrismaClient, ctx: SeedContext, friendlyId: string) {
  return (prisma as unknown as PrismaClient).taskRun.create({
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

// Inserted before the real rows so the pre-fix cap-then-check code is starved of real ids.
const DANGLING_CONNECTION_COUNT = 10;
const REAL_CONNECTED_RUN_COUNT = 3; // <= CONNECTED_RUNS_DISPLAY_LIMIT (5): all must show up

describe("WaitpointPresenter#connectedRunIdsOn is robust to dangling (FK-free) connection rows", () => {
  heteroRunOpsPostgresTest(
    "returns the existing connected runs even when dangling connections precede them",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "dangling");
      const waitpoint = await seedWaitpoint(prisma17, ctx, "waitpoint_dangling");

      // Dangling connections: taskRunId points at a run that was NEVER created. The dedicated
      // `WaitpointRunConnection` model is scalar/FK-free, so this insert is legal.
      for (let i = 0; i < DANGLING_CONNECTION_COUNT; i++) {
        await prisma17.waitpointRunConnection.create({
          data: { taskRunId: `nonexistent_run_${i}`, waitpointId: waitpoint.id },
        });
      }

      // Real, existing connected runs -- created (and connected) AFTER the dangling rows.
      const realRuns = await Promise.all(
        Array.from({ length: REAL_CONNECTED_RUN_COUNT }, (_, i) =>
          seedRun(prisma17, ctx, `run_dangling_real_${i}`)
        )
      );
      for (const run of realRuns) {
        await prisma17.waitpointRunConnection.create({
          data: { taskRunId: run.id, waitpointId: waitpoint.id },
        });
      }

      legacyReplicaHolder.client = prisma14;
      newClientHolder.client = prisma17;

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

      expect(result).not.toBeNull();
      const friendlyIds = (result?.connectedRuns ?? []).map((r) => r.friendlyId).sort();
      expect(friendlyIds.length).toBeLessThanOrEqual(CONNECTED_RUNS_DISPLAY_LIMIT);
      // The bug: cap-before-existence-check lets dangling rows starve out the real ones, so this
      // fails (returns fewer than REAL_CONNECTED_RUN_COUNT, often zero) on unfixed code.
      expect(friendlyIds).toEqual(
        realRuns.map((r) => r.friendlyId).sort((a, b) => a.localeCompare(b))
      );
    }
  );
});
