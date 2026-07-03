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

/**
 * Wraps a real prisma handle in a Proxy whose `taskRun.findFirst` throws if invoked. Used to
 * prove the empty-state probe never touches the legacy replica when the new DB already answers.
 * All other access forwards to the real client (so FK parents etc. still resolve).
 */
function throwingFindFirst(prisma: PrismaClient, label: string): PrismaClient {
  return new Proxy(prisma, {
    get(target, prop) {
      if (prop === "taskRun") {
        return new Proxy((target as any).taskRun, {
          get(trTarget, trProp) {
            if (trProp === "findFirst") {
              return async () => {
                throw new Error(`${label}.taskRun.findFirst must not be invoked`);
              };
            }
            return (trTarget as any)[trProp];
          },
        });
      }
      return (target as any)[prop];
    },
  }) as unknown as PrismaClient;
}

const callOptions = (ctx: SeedContext, overrides?: { to?: number }) => ({
  projectId: ctx.projectId,
  pageSize: 10,
  ...overrides,
});

// `to` one hour in the past. The CH page filters `created_at <= to`, so a just-created run is
// deterministically excluded regardless of replication timing — the empty-state tests otherwise
// raced on the run not having replicated yet (held locally, failed on CI). The PG existence probe
// has no time filter, so it still finds the row and `hasAnyRuns` stays true.
const emptyPageWindow = (): { to: number } => ({ to: Date.now() - 60 * 60 * 1000 });

describe("NextRunListPresenter dual-DB empty-state probe + routed hydrate (legacy + new Postgres)", () => {
  // no-false-empty. Runs ONLY on legacy, none on new. Empty CH page -> listRuns returns [].
  // splitEnabled true. The probe misses NEW, falls through to the legacy replica and finds the
  // row, so the dashboard must NOT show "no runs".
  replicationContainerTest(
    "no-false-empty: runs only on the legacy replica still report hasAnyRuns true",
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

      try {
        const ctx = await seedParents(prisma, "nofalseempty");
        await mirrorParents(prismaNew, ctx, "nofalseempty");

        // Run lives ONLY on the legacy DB. We seed it to legacy and never wait for CH replication,
        // so within the page window the CH id-set page is empty and listRuns returns []. The
        // empty-state probe (NEW miss -> legacy hit) is what proves hasAnyRuns stays true.
        await createRun(prisma, ctx, { friendlyId: "run_legacyOnly" });

        const presenter = new NextRunListPresenter(prisma, clickhouse, {
          newClient: prismaNew,
          legacyReplica: prisma,
          splitEnabled: true,
        });

        const result = await presenter.call(
          ctx.organizationId,
          ctx.environmentId,
          callOptions(ctx, emptyPageWindow())
        );

        // CH id-set is empty within the page window, but the legacy probe finds the row.
        expect(result.runs).toHaveLength(0);
        expect(result.hasAnyRuns).toBe(true);
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );

  // new-DB short-circuit. A run on NEW, legacy replica wrapped so its taskRun.findFirst
  // throws. Empty CH page. The probe answers from NEW and must NEVER fall through to legacy. The
  // post-migration straggler is the same shape: present on NEW, absent from LEGACY, legacy never
  // invoked.
  replicationContainerTest(
    "new-DB short-circuit: hasAnyRuns answered from the new DB without touching the legacy replica",
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

      try {
        const ctx = await seedParents(prisma, "newshortcircuit");
        await mirrorParents(prismaNew, ctx, "newshortcircuit");

        // The (migrated/straggler) run lives ONLY on NEW.
        await createRun(prismaNew, ctx, { friendlyId: "run_newOnly" });

        const legacySpy = throwingFindFirst(prisma, "legacyReplica");

        const presenter = new NextRunListPresenter(prisma, clickhouse, {
          newClient: prismaNew,
          legacyReplica: legacySpy,
          splitEnabled: true,
        });

        // If the legacy spy were invoked, this would throw — the test passing IS the proof.
        const result = await presenter.call(
          ctx.organizationId,
          ctx.environmentId,
          callOptions(ctx)
        );

        expect(result.runs).toHaveLength(0);
        expect(result.hasAnyRuns).toBe(true);
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );

  // genuinely empty. Nothing on either DB. Empty CH page. splitEnabled true. Both
  // probes run and return null -> the true empty state is preserved.
  replicationContainerTest(
    "genuinely empty: both DBs empty reports hasAnyRuns false",
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

      try {
        const ctx = await seedParents(prisma, "trulyempty");
        await mirrorParents(prismaNew, ctx, "trulyempty");

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

        expect(result.runs).toHaveLength(0);
        expect(result.hasAnyRuns).toBe(false);
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );

  // passthrough single-DB (two-arg ctor). One `prisma`, seed a run, empty CH page.
  // splitEnabled defaults false -> exactly one plain findFirst against the single handle; the
  // split branch (new/legacy) is structurally never entered (no second handle is injected).
  // Also covers "served from the replica only" — the ctor exposes no legacy-writer field, so a
  // no-primary-read guarantee is structural.
  replicationContainerTest(
    "passthrough single-DB: two-arg ctor finds the run via the single handle",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      legacyReplicaHolder.client = prisma;

      const ctx = await seedParents(prisma, "passthrough");
      await createRun(prisma, ctx, { friendlyId: "run_passthrough" });

      // Two-arg ctor: no readThroughDeps -> RunsRepository.readThrough is undefined
      // (passthrough) and the probe is one plain `this.replica.taskRun.findFirst`.
      const presenter = new NextRunListPresenter(prisma, clickhouse);

      const result = await presenter.call(
        ctx.organizationId,
        ctx.environmentId,
        callOptions(ctx, emptyPageWindow())
      );

      expect(result.runs).toHaveLength(0);
      expect(result.hasAnyRuns).toBe(true);
    }
  );

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
