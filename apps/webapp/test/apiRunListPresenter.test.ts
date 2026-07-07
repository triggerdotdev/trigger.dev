import { describe, expect, vi } from "vitest";

// The presenter graph imports `~/v3/runStore.server` (via RunsRepository) which imports
// `~/db.server` at load, and the presenter itself reaches `~/db.server`'s `$replica` singleton
// through `findDisplayableEnvironment` and `getTaskIdentifiers`. Stub the module so those
// singleton reads resolve. This is the ONLY mock — the DB is NEVER mocked; the proxy delegates
// to the per-test REAL legacy (PG14) container so the env-lookup + task-identifier reads hit a
// real database. Everything asserted runs against real containers. Mirrors
// nextRunListPresenter.readthrough.test.ts.
const legacyReplicaHolder = vi.hoisted(() => ({ client: undefined as any }));
const newClientHolder = vi.hoisted(() => ({ client: undefined as any }));
// `ApiRunListPresenter` resolves its read ClickHouse internally via the `clickhouseFactory`
// singleton (which imports `~/env.server` and binds to a process-wide default client). Stub the
// instance module so `getClickhouseForOrganization` returns the per-test container's ClickHouse
// handle (set by each test before calling). This is a module-resolution shim — the ClickHouse is
// a REAL testcontainer, never mocked — mirroring the `~/db.server` stub below.
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
        get(_t, prop) {
          if (!holder.client) {
            throw new Error(`${label} not set for this test`);
          }
          return holder.client[prop];
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
import { setupClickhouseReplication } from "./utils/replicationUtils";

vi.setConfig({ testTimeout: 90_000 });

type SeedContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  environmentSlug: string;
};

/**
 * Creates the org/project/env parents on a single prisma client. TaskRun FKs require these to
 * exist on every DB a run lives on, so identical parents (same ids) are seeded on both the
 * legacy (PG14) and new (PG17) databases.
 */
async function seedParents(
  prisma: PrismaClient,
  slug: string,
  envSlug = `env-${slug}`
): Promise<SeedContext> {
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
      slug: envSlug,
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
    environmentSlug: runtimeEnvironment.slug,
  };
}

/** Adds an extra RuntimeEnvironment (control-plane row) to an existing project. */
async function addEnvironment(
  prisma: PrismaClient,
  ctx: SeedContext,
  slug: string,
  envSlug: string
): Promise<string> {
  const env = await prisma.runtimeEnvironment.create({
    data: {
      slug: envSlug,
      type: "STAGING",
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      apiKey: `tr_${envSlug}_${slug}`,
      pkApiKey: `pk_${envSlug}_${slug}`,
      shortcode: `sc-${envSlug}-${slug}`,
    },
  });
  return env.id;
}

/** Mirrors the org/project/env parents onto a second DB with the SAME ids. */
async function mirrorParents(prisma: PrismaClient, ctx: SeedContext, slug: string): Promise<void> {
  await prisma.organization.create({
    data: { id: ctx.organizationId, title: `org-${slug}`, slug: `org-${slug}` },
  });
  await prisma.project.create({
    data: {
      id: ctx.projectId,
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: ctx.organizationId,
      externalRef: `proj-${slug}`,
    },
  });
  await prisma.runtimeEnvironment.create({
    data: {
      id: ctx.environmentId,
      slug: ctx.environmentSlug,
      type: "DEVELOPMENT",
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      apiKey: `tr_dev_${slug}_b`,
      pkApiKey: `pk_dev_${slug}_b`,
      shortcode: `sc-${slug}-b`,
    },
  });
}

async function createRun(
  prisma: PrismaClient,
  ctx: SeedContext,
  run: {
    friendlyId: string;
    taskIdentifier?: string;
    status?: any;
    runtimeEnvironmentId?: string;
  }
) {
  return prisma.taskRun.create({
    data: {
      friendlyId: run.friendlyId,
      taskIdentifier: run.taskIdentifier ?? "my-task",
      status: run.status ?? "PENDING",
      payload: JSON.stringify({ foo: run.friendlyId }),
      traceId: run.friendlyId,
      spanId: run.friendlyId,
      queue: "test",
      runTags: [],
      runtimeEnvironmentId: run.runtimeEnvironmentId ?? ctx.environmentId,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
    },
  });
}

describe("ApiRunListPresenter public /runs list (PG14 legacy + PG17 new)", () => {
  // Public list serves run-ops rows through the routed store. The
  // forwarded readThroughDeps thread the dual-DB union into NextRunListPresenter; the public
  // payload (`{ data, pagination }`) must list the NEW ∪ legacy union, proving the public API
  // surfaces routed run-ops rows. The migrated/straggler rows (run_newA/run_newB) live on BOTH
  // DBs with the same id + friendlyId but a DISTINGUISHING taskIdentifier ("my-task-NEW" on PG17),
  // so a row served from the threaded newClient is identifiable in the public payload.
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
      // The routed store's default known-migrated probe reads `runOpsNewPrisma` -> PG17.
      newClientHolder.client = prismaNew;

      try {
        const ctx = await seedParents(prisma, "hydrate");
        await mirrorParents(prismaNew, ctx, "hydrate");

        // All four runs land on PG14 (legacy + replication source -> CH gets the full id-set).
        const legacyOnlyA = await createRun(prisma, ctx, { friendlyId: "run_legacyA" });
        const legacyOnlyB = await createRun(prisma, ctx, { friendlyId: "run_legacyB" });
        const migratedA = await createRun(prisma, ctx, { friendlyId: "run_newA" });
        const migratedB = await createRun(prisma, ctx, { friendlyId: "run_newB" });

        // The two "migrated" runs also live on NEW (authoritative during retention), same ids +
        // friendlyIds, but a DISTINGUISHING taskIdentifier so a row served from PG17 is
        // identifiable in the public payload.
        await createRun(prismaNew, ctx, { friendlyId: "run_newA", taskIdentifier: "my-task-NEW" });
        await createRun(prismaNew, ctx, { friendlyId: "run_newB", taskIdentifier: "my-task-NEW" });
        await prismaNew.taskRun.update({
          where: { friendlyId: "run_newA" },
          data: { id: migratedA.id },
        });
        await prismaNew.taskRun.update({
          where: { friendlyId: "run_newB" },
          data: { id: migratedB.id },
        });

        // Wait for CH replication so the id-set page is non-empty.
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

        // The public payload lists runs by `id` = `run.friendlyId`, id-desc ordered.
        const expectedFriendlyIds = [
          { id: migratedA.id, friendlyId: "run_newA" },
          { id: migratedB.id, friendlyId: "run_newB" },
          { id: legacyOnlyA.id, friendlyId: "run_legacyA" },
          { id: legacyOnlyB.id, friendlyId: "run_legacyB" },
        ]
          .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
          .map((r) => r.friendlyId);
        expect(result.data.map((r) => r.id)).toEqual(expectedFriendlyIds);

        // The migrated rows must carry the PG17-only taskIdentifier — only possible if the public
        // path hydrated them through the threaded newClient (PG17). taskKind falls back to STANDARD.
        const migratedRow = result.data.find((r) => r.id === "run_newA");
        expect(migratedRow?.taskIdentifier).toBe("my-task-NEW");
        expect(migratedRow?.taskKind).toBe("STANDARD");
        // The legacy-only rows surface from PG14, proving the legacyReplica is also exercised.
        expect(result.data.find((r) => r.id === "run_legacyA")?.taskIdentifier).toBe("my-task");

        // Pagination shape is present.
        expect(result.pagination).toHaveProperty("next");
        expect(result.pagination).toHaveProperty("previous");
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );

  // Genuinely-empty env returns { data: [], pagination } without error. Exercises the
  // empty-state probe beneath NextRunListPresenter (no rows on either DB; empty CH page).
  replicationContainerTest(
    "genuinely-empty env returns { data: [], pagination } without error",
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

      try {
        const ctx = await seedParents(prisma, "empty");
        await mirrorParents(prismaNew, ctx, "empty");

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

        expect(result.data).toEqual([]);
        expect(result.pagination).toHaveProperty("next");
        expect(result.pagination).toHaveProperty("previous");
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );

  // Env scoping unchanged: the control-plane runtimeEnvironment.findMany lookup
  // resolves the requested env via the `_replica` handle (NOT routed), with the 4th `environment`
  // arg omitted to force that branch. Result is scoped to the requested env only.
  replicationContainerTest(
    "env scoping resolves via the control-plane _replica handle (filter[env], 4th arg omitted)",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      legacyReplicaHolder.client = prisma;
      clickhouseHolder.client = clickhouse;

      const ctx = await seedParents(prisma, "scoping", "prod");
      const stagingEnvId = await addEnvironment(prisma, ctx, "scoping", "staging");

      // Runs in prod only; a run in staging must NOT surface when filter[env]=prod.
      await createRun(prisma, ctx, { friendlyId: "run_prod1" });
      await createRun(prisma, ctx, { friendlyId: "run_prod2" });
      await createRun(prisma, ctx, {
        friendlyId: "run_staging",
        runtimeEnvironmentId: stagingEnvId,
      });

      await setTimeout(1500);

      // Single-handle passthrough; the env lookup runs on `_replica` (= prisma) via findMany.
      const presenter = new ApiRunListPresenter(prisma, prisma);

      // 4th `environment` arg OMITTED -> forces the runtimeEnvironment.findMany branch.
      const result = await presenter.call(
        { id: ctx.projectId },
        { "page[size]": 10, "filter[env]": ["prod"] } as any,
        CURRENT_API_VERSION
      );

      // Scoped to the resolved prod env only.
      expect(result.data.map((r) => r.id).sort()).toEqual(["run_prod1", "run_prod2"]);
    }
  );

  // Passthrough (single-DB): two-arg-style construction (no readThroughDeps) ->
  // NextRunListPresenter receives undefined deps -> byte-identical single-DB path. The public
  // { data, pagination } shape is unchanged.
  replicationContainerTest(
    "single-DB passthrough: no readThroughDeps lists the seeded runs unchanged",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      legacyReplicaHolder.client = prisma;
      clickhouseHolder.client = clickhouse;

      const ctx = await seedParents(prisma, "passthrough");
      await createRun(prisma, ctx, { friendlyId: "run_pt1" });
      await createRun(prisma, ctx, { friendlyId: "run_pt2" });

      await setTimeout(1500);

      // No readThroughDeps -> passthrough, exactly as the routes construct it today.
      const presenter = new ApiRunListPresenter(prisma, prisma);

      const result = await presenter.call(
        { id: ctx.projectId },
        { "page[size]": 10 } as any,
        CURRENT_API_VERSION,
        { id: ctx.environmentId, organizationId: ctx.organizationId }
      );

      expect(result.data.map((r) => r.id).sort()).toEqual(["run_pt1", "run_pt2"]);
      expect(result).toHaveProperty("pagination");
      expect(result.pagination).toHaveProperty("next");
      expect(result.pagination).toHaveProperty("previous");
    }
  );
});
