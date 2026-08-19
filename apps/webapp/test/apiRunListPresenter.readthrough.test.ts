import { describe, expect, vi } from "vitest";

// The presenter graph imports `~/db.server` singletons even though the asserted reads use explicit
// clients. These lazy proxies delegate every access to the real per-test Postgres containers.
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

import { createPostgresContainer, replicationContainerTest } from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { CURRENT_API_VERSION } from "~/api/versions";
import { ApiRunListPresenter } from "~/presenters/v3/ApiRunListPresenter.server";
import { createRun, mirrorParents, seedParents } from "./helpers/apiRunListPresenterTestHelpers";
import { setupClickhouseReplication } from "./utils/replicationUtils";

vi.setConfig({ testTimeout: 90_000 });

describe("ApiRunListPresenter public /runs routed read-through", () => {
  replicationContainerTest(
    "public payload lists run-ops rows served via the routed store (NEW + legacy union)",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma, network }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const { url: newUrl } = await createPostgresContainer(network, {
        imageTag: "docker.io/postgres:17",
      });
      const prismaNew = new PrismaClient({ datasources: { db: { url: newUrl } } });
      legacyReplicaHolder.client = prisma;
      clickhouseHolder.client = clickhouse;
      newClientHolder.client = prismaNew;

      try {
        const ctx = await seedParents(prisma, "hydrate");
        await mirrorParents(prismaNew, ctx, "hydrate");

        // PG14 is the logical-replication source, so ClickHouse receives the complete ID set.
        const legacyOnlyA = await createRun(prisma, ctx, { friendlyId: "run_legacyA" });
        const legacyOnlyB = await createRun(prisma, ctx, { friendlyId: "run_legacyB" });
        const migratedA = await createRun(prisma, ctx, { friendlyId: "run_newA" });
        const migratedB = await createRun(prisma, ctx, { friendlyId: "run_newB" });

        // The routed PG17 rows use distinguishing values that prove NEW hydration won.
        await createRun(prismaNew, ctx, {
          friendlyId: "run_newA",
          taskIdentifier: "my-task-NEW",
        });
        await createRun(prismaNew, ctx, {
          friendlyId: "run_newB",
          taskIdentifier: "my-task-NEW",
        });
        await prismaNew.taskRun.update({
          where: { friendlyId: "run_newA" },
          data: { id: migratedA.id },
        });
        await prismaNew.taskRun.update({
          where: { friendlyId: "run_newB" },
          data: { id: migratedB.id },
        });

        await setTimeout(1500);

        const presenter = new ApiRunListPresenter(prisma, prisma, {
          newClient: prismaNew,
          legacyReplica: prisma,
          splitEnabled: true,
        });

        const result = await presenter.call(
          { id: ctx.projectId },
          { "page[size]": 10 } as any,
          CURRENT_API_VERSION,
          { id: ctx.environmentId, organizationId: ctx.organizationId }
        );

        const expectedFriendlyIds = [
          { id: migratedA.id, friendlyId: "run_newA" },
          { id: migratedB.id, friendlyId: "run_newB" },
          { id: legacyOnlyA.id, friendlyId: "run_legacyA" },
          { id: legacyOnlyB.id, friendlyId: "run_legacyB" },
        ]
          .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
          .map((run) => run.friendlyId);
        expect(result.data.map((run) => run.id)).toEqual(expectedFriendlyIds);

        const migratedRow = result.data.find((run) => run.id === "run_newA");
        expect(migratedRow?.taskIdentifier).toBe("my-task-NEW");
        expect(migratedRow?.taskKind).toBe("STANDARD");
        expect(result.data.find((run) => run.id === "run_legacyA")?.taskIdentifier).toBe("my-task");

        expect(result.pagination).toHaveProperty("next");
        expect(result.pagination).toHaveProperty("previous");
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );
});
