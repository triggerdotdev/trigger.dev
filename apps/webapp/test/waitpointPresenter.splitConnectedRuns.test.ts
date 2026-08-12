// FLOW-level gap: a waitpoint's connected runs SPLIT across BOTH physical DBs at once (some legacy,
// some new-resident) rather than the existing single-direction cross-DB cases in
// waitpointPresenter.dedicatedConnectedRuns.readthrough.test.ts. Asserts #connectedRunFriendlyIds
// unions friendlyIds gathered from BOTH stores in one read AND stays bounded to
// CONNECTED_RUNS_DISPLAY_LIMIT even when the combined total exceeds it. Real two-physical-DB
// topology (heteroRunOpsPostgresTest); never mocked beyond the same db.server/clickhouse/
// NextRunListPresenter echo seams the sibling presenter tests use.
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

// Echo the runId set back as runs so `result.connectedRuns` == the friendlyIds the presenter
// gathered cross-DB (isolates the gather from the CH hydrate, as the sibling tests do).
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

// Wire the presenter's run store to the test containers so the connected-run gather routes to the
// container DBs (NEW=dedicated, LEGACY=legacy) instead of the default localhost:5432 client. The
// gather's findWaitpointConnectedRunIds fans out to BOTH legs and unions, keeping the split intent.
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

async function seedRun(
  prisma: PrismaClient | RunOpsPrismaClient,
  ctx: SeedContext,
  friendlyId: string,
  id?: string
) {
  return (prisma as PrismaClient).taskRun.create({
    data: {
      ...(id ? { id } : {}),
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

describe("WaitpointPresenter — connected runs SPLIT across both physical DBs", () => {
  heteroRunOpsPostgresTest(
    "unions connected-run friendlyIds from both stores and stays bounded to the display limit",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "split");

      // Waitpoint resident on LEGACY.
      const waitpoint = await prisma14.waitpoint.create({
        data: {
          friendlyId: "waitpoint_split",
          type: "MANUAL",
          status: "COMPLETED",
          idempotencyKey: "idem-waitpoint_split",
          userProvidedIdempotencyKey: false,
          outputType: "application/json",
          outputIsError: false,
          completedAt: new Date(),
          tags: [],
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
        },
      });

      // 2 connected runs resident + joined on NEW (below the limit on its own).
      const NEW_RUN_FRIENDLY_IDS = ["run_split_new0", "run_split_new1"];
      for (const friendlyId of NEW_RUN_FRIENDLY_IDS) {
        const run = await seedRun(prisma17, ctx, friendlyId, `run_${generateRunOpsId()}`);
        await prisma17.waitpointRunConnection.create({
          data: { taskRunId: run.id, waitpointId: waitpoint.id },
        });
      }

      // 6 connected runs resident + joined on LEGACY via the implicit M2M — more than enough, on its
      // own, to push the combined total past CONNECTED_RUNS_DISPLAY_LIMIT (5).
      const LEGACY_RUN_FRIENDLY_IDS = Array.from({ length: 6 }, (_, i) => `run_split_leg${i}`);
      for (const friendlyId of LEGACY_RUN_FRIENDLY_IDS) {
        const run = await seedRun(prisma14, ctx, friendlyId);
        await prisma14.waitpoint.update({
          where: { id: waitpoint.id },
          data: { connectedRuns: { connect: [{ id: run.id }] } },
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
        makeRunStore(prisma17 as unknown as PrismaClient, prisma14)
      );

      const result = await presenter.call({
        friendlyId: waitpoint.friendlyId,
        environmentId: ctx.environmentId,
        projectId: ctx.projectId,
      });

      const returnedIds = result?.connectedRuns.map((r) => r.friendlyId) ?? [];

      // Bounded: the combined total across both DBs (8) must never surface more than the display
      // limit, proving the fetch is capped globally, not just per-DB.
      expect(returnedIds.length).toBeLessThanOrEqual(CONNECTED_RUNS_DISPLAY_LIMIT);
      expect(returnedIds.length).toBeGreaterThan(0);

      // BOTH stores contributed: at least one NEW-resident and one LEGACY-resident connected run
      // friendlyId made it into the result. A single-store gather (the bug this guards against)
      // would surface only one side.
      const fromNew = returnedIds.filter((id) => NEW_RUN_FRIENDLY_IDS.includes(id));
      const fromLegacy = returnedIds.filter((id) => LEGACY_RUN_FRIENDLY_IDS.includes(id));
      expect(fromNew.length).toBeGreaterThan(0);
      expect(fromLegacy.length).toBeGreaterThan(0);
      expect(fromNew.length + fromLegacy.length).toBe(returnedIds.length);
    }
  );
});
