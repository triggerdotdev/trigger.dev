import { describe, expect, vi } from "vitest";

// Uses the REAL dedicated run-ops client (RunOpsPrismaClient / SUBSET schema) as the new-DB handle,
// whose `Waitpoint` model has NO `connectedRuns` relation — so a relation-select of it throws rather
// than missing. The existing suite can't catch that: it wires a full-schema PG17 as the "new" client.
// NextRunListPresenter is stubbed to echo its `runId` set back as `runs`, so `result.connectedRuns` is
// exactly the friendlyIds the presenter gathered cross-DB (isolating the gather from the CH hydrate).
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
  };
});

vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: {
    getClickhouseForOrganization: async () => ({}),
  },
}));

// Echo the runId set back as runs so `result.connectedRuns` == the friendlyIds the presenter gathered.
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
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { WaitpointPresenter } from "~/presenters/v3/WaitpointPresenter.server";

vi.setConfig({ testTimeout: 90_000 });

type SeedContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

// Parents (org/project/env) only exist on the full control-plane schema; the dedicated subset has no
// such models, so we always seed them on the legacy (PG14) client and let the resolver read them there.
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
      output: JSON.stringify({ hello: "world" }),
      outputType: "application/json",
      outputIsError: false,
      completedAt: new Date(),
      tags: ["a", "b"],
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

const callArgs = (ctx: SeedContext, friendlyId: string) => ({
  friendlyId,
  environmentId: ctx.environmentId,
  projectId: ctx.projectId,
});

describe("WaitpointPresenter against the REAL dedicated run-ops client", () => {
  // A NEW-resident waitpoint (on the dedicated subset schema) with no connected runs. The current
  // relation-select of `connectedRuns` is invalid on the dedicated Waitpoint model, so the read
  // throws PrismaClientValidationError. Desired: resolves the waitpoint, connectedRuns empty.
  heteroRunOpsPostgresTest(
    "resolves a new-resident waitpoint without a connectedRuns relation-select (no throw)",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "dedself");
      const seeded = await seedWaitpoint(prisma17, ctx, "waitpoint_dedself");

      legacyReplicaHolder.client = prisma14;
      newClientHolder.client = prisma17;

      const presenter = new WaitpointPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: prisma17 as unknown as PrismaClient,
        legacyReplica: prisma14,
      });

      const result = await presenter.call(callArgs(ctx, seeded.friendlyId));

      expect(result?.id).toBe(seeded.friendlyId);
      expect(result?.connectedRuns).toEqual([]);
    }
  );

  // Cross-DB connection: waitpoint on LEGACY (PG14), the connected run + its WaitpointRunConnection
  // join on the NEW dedicated DB (PG17). A single-DB gather off the waitpoint's own store misses the
  // run entirely; the fix reads the join from BOTH stores (dedicated `waitpointRunConnection`
  // delegate + legacy raw `_WaitpointRunConnections`) and unions the friendlyIds.
  heteroRunOpsPostgresTest(
    "gathers a cross-DB connected run whose join lives on the other database",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "crossdb");
      const waitpoint = await seedWaitpoint(prisma14, ctx, "waitpoint_crossdb");

      // The connected run + join live only on the NEW dedicated DB (co-resident with the run).
      const run = await seedRun(prisma17, ctx, "run_crossnew");
      await prisma17.waitpointRunConnection.create({
        data: { taskRunId: run.id, waitpointId: waitpoint.id },
      });

      legacyReplicaHolder.client = prisma14;
      newClientHolder.client = prisma17;

      const presenter = new WaitpointPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: prisma17 as unknown as PrismaClient,
        legacyReplica: prisma14,
      });

      const result = await presenter.call(callArgs(ctx, waitpoint.friendlyId));

      expect(result?.id).toBe(waitpoint.friendlyId);
      expect(result?.connectedRuns.map((r) => r.friendlyId)).toEqual(["run_crossnew"]);
    }
  );

  // Same-DB legacy connection (no regression): waitpoint + connected run both on LEGACY, joined via
  // the implicit `_WaitpointRunConnections` M2M. The gather must read the legacy raw join path.
  heteroRunOpsPostgresTest(
    "still gathers a same-DB legacy connected run via the implicit M2M",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "legsame");
      const run = await seedRun(prisma14, ctx, "run_legsame");
      const waitpoint = await prisma14.waitpoint.create({
        data: {
          friendlyId: "waitpoint_legsame",
          type: "MANUAL",
          status: "COMPLETED",
          idempotencyKey: "idem-waitpoint_legsame",
          userProvidedIdempotencyKey: false,
          outputType: "application/json",
          outputIsError: false,
          completedAt: new Date(),
          tags: [],
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
          connectedRuns: { connect: [{ id: run.id }] },
        },
      });

      legacyReplicaHolder.client = prisma14;
      newClientHolder.client = prisma17;

      const presenter = new WaitpointPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: prisma17 as unknown as PrismaClient,
        legacyReplica: prisma14,
      });

      const result = await presenter.call(callArgs(ctx, waitpoint.friendlyId));

      expect(result?.connectedRuns.map((r) => r.friendlyId)).toEqual(["run_legsame"]);
    }
  );
});
