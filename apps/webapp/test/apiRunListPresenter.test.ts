import { describe, expect, vi } from "vitest";

// The presenter graph imports `~/db.server` singletons even though these tests pass explicit real
// clients. The proxies keep those singleton reads on the current warm Postgres fixture.
const legacyReplicaHolder = vi.hoisted(() => ({ client: undefined as any }));
const newClientHolder = vi.hoisted(() => ({ client: undefined as any }));
const clickhouseHolder = vi.hoisted(() => ({ client: undefined as any }));

vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: {
    getClickhouseForOrganization: async () => {
      if (!clickhouseHolder.client) {
        throw new Error("clickhouseHolder.client not set for this test");
      }
      return clickhouseHolder.client;
    },
  },
}));

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  const lazyProxy = (holder: { client: any }, label: string) =>
    new Proxy(
      {},
      {
        get(_target, property) {
          if (!holder.client) {
            throw new Error(`${label} not set for this test`);
          }
          return holder.client[property];
        },
      }
    );
  const replicaProxy = lazyProxy(legacyReplicaHolder, "legacyReplicaHolder.client");
  const newProxy = lazyProxy(newClientHolder, "newClientHolder.client");

  return {
    prisma: replicaProxy,
    $replica: replicaProxy,
    runOpsNewPrisma: newProxy,
    runOpsNewReplica: newProxy,
    runOpsLegacyPrisma: replicaProxy,
    runOpsLegacyReplica: replicaProxy,
    sqlDatabaseSchema: Prisma.sql([`public`]),
  };
});

import { ClickHouse } from "@internal/clickhouse";
import { containerTest } from "@internal/testcontainers";
import { CURRENT_API_VERSION } from "~/api/versions";
import { ApiRunListPresenter } from "~/presenters/v3/ApiRunListPresenter.server";
import {
  addEnvironment,
  createRun,
  insertTaskRunV2Rows,
  seedParents,
} from "./helpers/apiRunListPresenterTestHelpers";

vi.setConfig({ testTimeout: 90_000 });

function setupClients(prisma: unknown, clickhouseUrl: string): ClickHouse {
  const clickhouse = new ClickHouse({
    url: clickhouseUrl,
    name: "api-run-list-presenter-test",
    compression: { request: true },
  });
  legacyReplicaHolder.client = prisma;
  newClientHolder.client = prisma;
  clickhouseHolder.client = clickhouse;
  return clickhouse;
}

describe("ApiRunListPresenter public /runs list", () => {
  containerTest(
    "genuinely-empty env returns { data: [], pagination } without error",
    async ({ clickhouseContainer, prisma }) => {
      setupClients(prisma, clickhouseContainer.getConnectionUrl());
      const ctx = await seedParents(prisma, "empty");

      // Keep the split/read-through branch active while both real clients point at the empty DB.
      const presenter = new ApiRunListPresenter(prisma, prisma, {
        newClient: prisma,
        legacyReplica: prisma,
        splitEnabled: true,
      });

      const result = await presenter.call(
        { id: ctx.projectId },
        { "page[size]": 10 } as any,
        CURRENT_API_VERSION,
        { id: ctx.environmentId, organizationId: ctx.organizationId }
      );

      expect(result.data).toEqual([]);
      expect(result.pagination).toHaveProperty("next");
      expect(result.pagination).toHaveProperty("previous");
    }
  );

  containerTest(
    "env scoping resolves via the control-plane _replica handle (filter[env], 4th arg omitted)",
    async ({ clickhouseContainer, prisma }) => {
      const clickhouse = setupClients(prisma, clickhouseContainer.getConnectionUrl());
      const ctx = await seedParents(prisma, "scoping", "prod");
      const stagingEnvironmentId = await addEnvironment(prisma, ctx, "scoping", "staging");

      // The Postgres rows exercise real hydration; matching ClickHouse rows provide the list IDs.
      const runs = await Promise.all([
        createRun(prisma, ctx, { friendlyId: "run_prod1" }),
        createRun(prisma, ctx, { friendlyId: "run_prod2" }),
        createRun(prisma, ctx, {
          friendlyId: "run_staging",
          runtimeEnvironmentId: stagingEnvironmentId,
        }),
      ]);
      await insertTaskRunV2Rows(clickhouse, runs);

      const presenter = new ApiRunListPresenter(prisma, prisma);

      // Omitting the fourth argument forces the control-plane runtimeEnvironment.findMany branch.
      const result = await presenter.call(
        { id: ctx.projectId },
        { "page[size]": 10, "filter[env]": ["prod"] } as any,
        CURRENT_API_VERSION
      );

      expect(result.data.map((run) => run.id).sort()).toEqual(["run_prod1", "run_prod2"]);
    }
  );

  containerTest(
    "single-DB passthrough: no readThroughDeps lists the seeded runs unchanged",
    async ({ clickhouseContainer, prisma }) => {
      const clickhouse = setupClients(prisma, clickhouseContainer.getConnectionUrl());
      const ctx = await seedParents(prisma, "passthrough");
      const runs = await Promise.all([
        createRun(prisma, ctx, { friendlyId: "run_pt1" }),
        createRun(prisma, ctx, { friendlyId: "run_pt2" }),
      ]);
      await insertTaskRunV2Rows(clickhouse, runs);

      // No readThroughDeps preserves the single-database path used by existing callers.
      const presenter = new ApiRunListPresenter(prisma, prisma);

      const result = await presenter.call(
        { id: ctx.projectId },
        { "page[size]": 10 } as any,
        CURRENT_API_VERSION,
        { id: ctx.environmentId, organizationId: ctx.organizationId }
      );

      expect(result.data.map((run) => run.id).sort()).toEqual(["run_pt1", "run_pt2"]);
      expect(result).toHaveProperty("pagination");
      expect(result.pagination).toHaveProperty("next");
      expect(result.pagination).toHaveProperty("previous");
    }
  );
});
