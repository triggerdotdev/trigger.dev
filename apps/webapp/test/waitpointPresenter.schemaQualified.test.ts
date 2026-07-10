// RED->GREEN guard: #connectedRunIdsOn's raw SQL must schema-qualify every table reference with
// sqlDatabaseSchema (the repo-wide convention every other raw-SQL call site follows —
// task.server.ts, TestPresenter, DeploymentListPresenter). Unqualified names ("WaitpointRunConnection",
// "TaskRun", "_WaitpointRunConnections") resolve against search_path, so a non-`public` schema=
// deployment would hit the wrong schema or miss the tables entirely.
//
// This intercepts the REAL $queryRawUnsafe on BOTH physical clients (pure instrumentation over a
// real testcontainer client — the DB still executes the query and returns real rows) and captures
// the SQL text, then asserts every table reference is schema-qualified. Uses the split topology so
// BOTH raw-SQL branches run: dedicated `WaitpointRunConnection` (prisma17) and legacy implicit M2M
// `_WaitpointRunConnections` (prisma14). $queryRawUnsafe (not a Prisma.Sql fragment) is exactly what
// the fix uses: the two clients are different Prisma runtimes, so a foreign runtime's Sql fragment
// would be bound as a param rather than inlined.
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
    // The real schema constant is derived from DATABASE_URL's `schema=` search param. `public` keeps
    // the query runnable against the testcontainer while still exercising qualification.
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
import { type PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { WaitpointPresenter } from "~/presenters/v3/WaitpointPresenter.server";

vi.setConfig({ testTimeout: 90_000 });

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

// Capture the SQL text of every `$queryRawUnsafe` call, delegating unchanged to the real client
// (the DB still runs the query -- pure instrumentation, never a mock). Everything else passes
// straight through to the real client.
function capturingQueryRaw<T extends object>(real: T): { client: T; sqls: string[] } {
  const sqls: string[] = [];
  const client = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "$queryRawUnsafe") {
        return (query: string, ...params: unknown[]) => {
          sqls.push(query);
          return (target as any).$queryRawUnsafe(query, ...params);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
  return { client, sqls };
}

describe("WaitpointPresenter#connectedRunIdsOn schema-qualifies every raw-SQL table reference", () => {
  heteroRunOpsPostgresTest(
    "both the dedicated WaitpointRunConnection and legacy _WaitpointRunConnections branches qualify tables with sqlDatabaseSchema",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "schemaqual");

      // Waitpoint resident on LEGACY (drives the implicit-M2M `_WaitpointRunConnections` branch).
      const waitpoint = await prisma14.waitpoint.create({
        data: {
          friendlyId: "waitpoint_schemaqual",
          type: "MANUAL",
          status: "COMPLETED",
          idempotencyKey: "idem-waitpoint_schemaqual",
          userProvidedIdempotencyKey: false,
          outputType: "application/json",
          outputIsError: false,
          completedAt: new Date(),
          tags: [],
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
        },
      });

      // A connected run resident + joined on NEW (dedicated `WaitpointRunConnection` branch).
      const newRun = await seedRun(prisma17, ctx, "run_schemaqual_new");
      await prisma17.waitpointRunConnection.create({
        data: { taskRunId: newRun.id, waitpointId: waitpoint.id },
      });

      // A connected run resident + joined on LEGACY via the implicit M2M.
      const legacyRun = await seedRun(prisma14, ctx, "run_schemaqual_legacy");
      await prisma14.waitpoint.update({
        where: { id: waitpoint.id },
        data: { connectedRuns: { connect: [{ id: legacyRun.id }] } },
      });

      legacyReplicaHolder.client = prisma14;
      newClientHolder.client = prisma17;

      const legacy = capturingQueryRaw(prisma14 as unknown as object);
      const dedicated = capturingQueryRaw(prisma17 as unknown as object);

      const presenter = new WaitpointPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: dedicated.client as unknown as PrismaClient,
        legacyReplica: legacy.client as unknown as PrismaClient,
      });

      const result = await presenter.call({
        friendlyId: waitpoint.friendlyId,
        environmentId: ctx.environmentId,
        projectId: ctx.projectId,
      });

      // The read still works end-to-end (schema-qualified names resolve against the testcontainer's
      // public schema), and both stores contributed a connected run.
      const returnedIds = (result?.connectedRuns ?? []).map((r) => r.friendlyId).sort();
      expect(returnedIds).toEqual(["run_schemaqual_legacy", "run_schemaqual_new"]);

      const allSqls = [...dedicated.sqls, ...legacy.sqls];
      // Sanity: both raw-SQL branches actually ran.
      expect(dedicated.sqls.length).toBeGreaterThan(0);
      expect(legacy.sqls.length).toBeGreaterThan(0);

      // Every table reference must be schema-qualified. The buggy (unqualified) code emits e.g.
      // `FROM "WaitpointRunConnection"` / `JOIN "TaskRun"`, so these fail RED.
      for (const sql of allSqls) {
        // No unqualified table references (a `"` or `.` must precede any of these table names).
        expect(sql).not.toMatch(/(?<![.\w"])"WaitpointRunConnection"/);
        expect(sql).not.toMatch(/(?<![.\w"])"_WaitpointRunConnections"/);
        expect(sql).not.toMatch(/(?<![.\w"])"TaskRun"/);
        // Every JOIN to TaskRun is schema-qualified.
        expect(sql).toMatch(/public\."TaskRun"/);
      }

      const dedicatedSql = dedicated.sqls.join("\n");
      const legacySql = legacy.sqls.join("\n");
      expect(dedicatedSql).toMatch(/public\."WaitpointRunConnection"/);
      expect(legacySql).toMatch(/public\."_WaitpointRunConnections"/);
    }
  );
});
