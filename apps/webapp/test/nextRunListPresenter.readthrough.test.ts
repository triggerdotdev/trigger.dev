import { describe, expect, vi } from "vitest";

// The presenter graph imports `~/v3/runStore.server` (via RunsRepository) which imports
// `~/db.server` at load, and the presenter itself reaches `~/db.server`'s `$replica` singleton
// through `findDisplayableEnvironment` and `getTaskIdentifiers`. Stub the module so those
// singleton reads resolve. This is the ONLY mock — the DB is NEVER mocked; the `$replica`
// stub delegates to the per-test REAL legacy container so the env-lookup + task-identifier
// reads hit a real database. Everything asserted runs against real containers.
//
// `legacyReplicaHolder.client` is set by each test to its real legacy `prisma` handle before
// calling the presenter; the proxy forwards every property access to it lazily. Created via
// vi.hoisted so it exists when the hoisted vi.mock factory runs.
// `legacyReplicaHolder.client` -> the legacy handle backing the `prisma`/`$replica`
// singletons; `newClientHolder.client` -> the new handle backing `runOpsNewPrisma`
// (used by the routed store's default known-migrated probe). Each test sets both before calling.
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
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import { setupClickhouseReplication } from "./utils/replicationUtils";

vi.setConfig({ testTimeout: 90_000 });

type SeedContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

/**
 * Creates the org/project/env parents on a single prisma client. TaskRun FKs require these to
 * exist on every DB a run lives on, so identical parents (same ids) are seeded on both the
 * legacy and new databases.
 */
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
      slug: `env-${slug}`,
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
  run: { friendlyId: string; taskIdentifier?: string; status?: any; runTags?: string[] }
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
      runTags: run.runTags ?? [],
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
    },
  });
}

const callOptions = (ctx: SeedContext) => ({
  projectId: ctx.projectId,
  pageSize: 10,
});

describe("NextRunListPresenter routed hydrate (legacy + new Postgres)", () => {
  // list hydrate flows through the routed store: split, non-empty CH id-set whose rows are
  // split across NEW + the legacy replica. result.runs must be the union, id-desc ordered. This
  // proves the deps are threaded so the routed store is actually used.
  // We assert the rows that DO surface (the full union, since legacy is probed for any id that
  // misses on NEW).
  // The migrated runs (run_newA/run_newB) live on BOTH DBs with the same id + friendlyId but a
  // DISTINGUISHING taskIdentifier: "my-task" on legacy, "my-task-NEW" on new. #hydrateRunsByIds
  // takes NEW rows first and only probes legacy for ids NOT on NEW, so a migrated row can only
  // carry "my-task-NEW" if it was served from the threaded newClient (new DB) — asserted below.
  replicationContainerTest(
    "list hydrate flows through the routed store: result.runs is the NEW + legacy union, id-desc",
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
      // The routed store's default known-migrated probe reads `runOpsNewPrisma` -> the new DB.
      newClientHolder.client = prismaNew;

      try {
        const ctx = await seedParents(prisma, "hydrate");
        await mirrorParents(prismaNew, ctx, "hydrate");

        // All four runs land on the legacy DB (legacy + replication source -> CH gets the full id-set).
        const legacyOnlyA = await createRun(prisma, ctx, { friendlyId: "run_legacyA" });
        const legacyOnlyB = await createRun(prisma, ctx, { friendlyId: "run_legacyB" });
        const migratedA = await createRun(prisma, ctx, { friendlyId: "run_newA" });
        const migratedB = await createRun(prisma, ctx, { friendlyId: "run_newB" });

        // The two "migrated" runs also live on NEW (authoritative during retention), same ids +
        // friendlyIds, but a DISTINGUISHING taskIdentifier so a row served from the new DB is
        // identifiable: "my-task-NEW" here vs the default "my-task" on the legacy DB.
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

        const presenter = new NextRunListPresenter(prisma, clickhouse, {
          newClient: prismaNew,
          legacyReplica: prisma,
          splitEnabled: true,
        });

        const result = await presenter.call(
          ctx.organizationId,
          ctx.environmentId,
          callOptions(ctx)
        );

        const expectedIds = [migratedA.id, migratedB.id, legacyOnlyA.id, legacyOnlyB.id].sort(
          (a, b) => (a < b ? 1 : a > b ? -1 : 0)
        );
        expect(result.runs.map((r) => r.id)).toEqual(expectedIds);

        // The migrated rows must carry the new-DB-only taskIdentifier — this can only hold if they
        // were hydrated from the threaded newClient (new DB), proving the routed store used it.
        expect(result.runs.find((r) => r.id === migratedA.id)?.friendlyId).toBe("run_newA");
        expect(result.runs.find((r) => r.id === migratedA.id)?.taskIdentifier).toBe("my-task-NEW");
        expect(result.runs.find((r) => r.id === migratedB.id)?.taskIdentifier).toBe("my-task-NEW");
        // The legacy-only rows surface from the legacy DB with the legacy taskIdentifier — proving the
        // legacyReplica (legacy DB) is also exercised for ids absent from the new DB.
        expect(result.runs.find((r) => r.id === legacyOnlyA.id)?.friendlyId).toBe("run_legacyA");
        expect(result.runs.find((r) => r.id === legacyOnlyA.id)?.taskIdentifier).toBe("my-task");
        expect(result.runs.find((r) => r.id === legacyOnlyB.id)?.taskIdentifier).toBe("my-task");

        // Non-empty page -> the empty-state probe is not consulted, but it's still true.
        expect(result.hasAnyRuns).toBe(true);
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );
});
