import { describe, expect, vi } from "vitest";

// The runsRepository module graph imports `~/v3/runStore.server`, which imports `~/db.server`
// at load. Stub it (the existing runsRepository.part*.test.ts / readthrough test do the same) — the
// resolver under test is driven entirely through injected real containers, never the stubbed
// module singletons.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { createPostgresContainer, replicationContainerTest } from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { ClickHouseRunListResolver } from "~/services/realtime/clickHouseRunListResolver.server";
import { setupClickhouseReplication } from "../utils/replicationUtils";

vi.setConfig({ testTimeout: 90_000 });

type SeedContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

/**
 * Creates the org/project/env parents on a single prisma client. TaskRun FKs require these to
 * exist, and this container doubles as the logical-replication source that feeds the
 * ClickHouse id-set, so all runs whose ids we expect from ClickHouse are seeded here.
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

/** A second environment in the same project — used to prove the CH filter excludes other envs. */
async function seedSecondEnvironment(prisma: PrismaClient, ctx: SeedContext, slug: string) {
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}-2`,
      type: "PRODUCTION",
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `sc-${slug}-2`,
    },
  });
  return runtimeEnvironment.id;
}

async function createRun(
  prisma: PrismaClient,
  ctx: SeedContext & { environmentId?: string },
  run: { friendlyId: string; runTags?: string[]; createdAt?: Date }
) {
  return prisma.taskRun.create({
    data: {
      friendlyId: run.friendlyId,
      taskIdentifier: "my-task",
      status: "PENDING",
      payload: JSON.stringify({ foo: run.friendlyId }),
      traceId: run.friendlyId,
      spanId: run.friendlyId,
      queue: "test",
      runTags: run.runTags ?? [],
      ...(run.createdAt ? { createdAt: run.createdAt } : {}),
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
    },
  });
}

/**
 * Wraps a real prisma client so ONLY `taskRun.findMany` throws — every other member stays a real
 * handle. The resolver's id-set path (`listRunIds` -> `listRunRows`) performs no `taskRun.findMany`
 * and never calls the run-ops store, so this proxy must never trip. The CPRES-owned filter
 * resolution that DOES run for a `batchId` filter uses `batchTaskRun.findFirst`, which this proxy
 * leaves intact.
 */
function throwingTaskRunFindMany(prisma: PrismaClient): PrismaClient {
  return new Proxy(prisma, {
    get(target, prop) {
      if (prop === "taskRun") {
        return new Proxy((target as any).taskRun, {
          get(trTarget, trProp) {
            if (trProp === "findMany") {
              return async () => {
                throw new Error(
                  "taskRun.findMany must not be invoked on the realtime id-set path (a hydrate leaked in)"
                );
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

describe("ClickHouseRunListResolver (realtime run-list id-set, split-neutral)", () => {
  // resolves the CH id-set with NO TaskRun PG hydrate.
  replicationContainerTest(
    "resolves the ClickHouse id-set for run-ops rows without ever reading TaskRun in Postgres",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const ctx = await seedParents(prisma, "idset");

      const runA = await createRun(prisma, ctx, { friendlyId: "run_idsetA" });
      const runB = await createRun(prisma, ctx, { friendlyId: "run_idsetB" });
      const runC = await createRun(prisma, ctx, { friendlyId: "run_idsetC" });

      await setTimeout(1500);

      // ONLY taskRun.findMany throws; the rest of the client is real so the resolver can run.
      const resolver = new ClickHouseRunListResolver({
        getClickhouse: async () => clickhouse,
        prisma: throwingTaskRunFindMany(prisma),
      });

      const runIds = await resolver.resolveMatchingRunIds({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
        limit: 10,
      });

      // Asserting as a set: equal createdAt makes the CH (created_at, run_id) DESC tie-break the
      // only ordering signal. The throwing proxy never tripped -> no TaskRun hydrate on this path.
      expect([...runIds].sort()).toEqual([runA.id, runB.id, runC.id].sort());
    }
  );

  // CH filter is split-neutral (ids independent of PG residency).
  replicationContainerTest(
    "returns the same id-set regardless of which Postgres the rows are hydrated from (CH-only path)",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma, network }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      // A second, unrelated NEW client carrying NO rows. The id-set path never touches it;
      // pointing the resolver at it must not change the result, proving the ids come from CH only.
      const { url: newUrl } = await createPostgresContainer(network, {
        imageTag: "docker.io/postgres:17",
      });
      const prismaNew = new PrismaClient({ datasources: { db: { url: newUrl } } });

      try {
        const ctx = await seedParents(prisma, "neutral");
        const runA = await createRun(prisma, ctx, { friendlyId: "run_neutralA" });
        const runB = await createRun(prisma, ctx, { friendlyId: "run_neutralB" });

        await setTimeout(1500);

        const filter = {
          organizationId: ctx.organizationId,
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
          limit: 10,
        };

        // "single-DB" wiring: resolver's prisma is the replication-source DB (where rows live).
        const singleDb = new ClickHouseRunListResolver({
          getClickhouse: async () => clickhouse,
          prisma,
        });
        // "split" wiring: resolver's prisma is the empty NEW DB. If the id-set path read TaskRun
        // from this handle the result would differ; it must not.
        const split = new ClickHouseRunListResolver({
          getClickhouse: async () => clickhouse,
          prisma: prismaNew,
        });

        const idsSingleDb = await singleDb.resolveMatchingRunIds(filter);
        const idsSplit = await split.resolveMatchingRunIds(filter);

        expect(idsSplit).toEqual(idsSingleDb);
        expect([...idsSingleDb].sort()).toEqual([runA.id, runB.id].sort());
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );

  // single-DB passthrough; no legacy/known-migrated probe on this path.
  replicationContainerTest(
    "single-DB passthrough returns the CH id-set and never hydrates TaskRun",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const ctx = await seedParents(prisma, "passthrough");
      const run = await createRun(prisma, ctx, { friendlyId: "run_passthrough" });

      await setTimeout(1500);

      const resolver = new ClickHouseRunListResolver({
        getClickhouse: async () => clickhouse,
        prisma: throwingTaskRunFindMany(prisma),
      });

      const runIds = await resolver.resolveMatchingRunIds({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
        limit: 10,
      });

      expect(runIds).toEqual([run.id]);
    }
  );

  // a far-future straggler's id surfaces from the CH id-set.
  replicationContainerTest(
    "surfaces a far-future delayed run's id from the CH id-set",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const ctx = await seedParents(prisma, "straggler");

      const now = new Date();
      const near = await createRun(prisma, ctx, { friendlyId: "run_near", createdAt: now });
      // The migrated-by-sweep case: CH is residency-agnostic, so the id surfaces once indexed
      // regardless of which DB holds the row.
      const farFuture = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
      const straggler = await createRun(prisma, ctx, {
        friendlyId: "run_straggler",
        createdAt: farFuture,
      });

      await setTimeout(1500);

      const resolver = new ClickHouseRunListResolver({
        getClickhouse: async () => clickhouse,
        prisma,
      });

      const runIds = await resolver.resolveMatchingRunIds({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
        limit: 10,
      });

      expect(runIds).toContain(straggler.id);
      expect(runIds).toContain(near.id);
      // (created_at, run_id) DESC ordering -> the far-future straggler sorts ahead of the near run.
      expect(runIds.indexOf(straggler.id)).toBeLessThan(runIds.indexOf(near.id));
    }
  );

  // tag match is contains-ALL (tagsMatch: "all" -> hasAll), authoritative.
  // The sibling runReader.server.ts JSDoc still calls RunListFilter.tags "Contains-ANY"; that is
  // stale. The resolver passes tagsMatch: "all" and the live CH repo maps
  // it to hasAll, so contains-ALL is the real behavior — assert that, not the JSDoc.
  replicationContainerTest(
    "tag filter is contains-ALL: only runs carrying every requested tag are returned",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const ctx = await seedParents(prisma, "tags");

      // Has BOTH requested tags -> matches contains-ALL.
      const both = await createRun(prisma, ctx, {
        friendlyId: "run_bothTags",
        runTags: ["alpha", "beta"],
      });
      // Has only one of the requested tags -> excluded under contains-ALL (would match contains-ANY).
      await createRun(prisma, ctx, { friendlyId: "run_oneTag", runTags: ["alpha"] });
      // Has neither -> excluded.
      await createRun(prisma, ctx, { friendlyId: "run_otherTag", runTags: ["gamma"] });

      await setTimeout(1500);

      const resolver = new ClickHouseRunListResolver({
        getClickhouse: async () => clickhouse,
        prisma,
      });

      const runIds = await resolver.resolveMatchingRunIds({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
        tags: ["alpha", "beta"],
        limit: 10,
      });

      // contains-ALL: only the run with BOTH tags. (contains-ANY would also return run_oneTag.)
      expect(runIds).toEqual([both.id]);
    }
  );

  // environment scoping: the CH filter excludes other environments.
  // Doubles as a structural proof that an accidental hydrate would NOT change the id-set: rows on a
  // different env are not returned because CH filters by environment_id, not because PG was read.
  replicationContainerTest(
    "scopes the id-set to the filtered environment (other-env rows are excluded by the CH filter)",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const ctx = await seedParents(prisma, "envscope");
      const otherEnvId = await seedSecondEnvironment(prisma, ctx, "envscope");

      const inEnv = await createRun(prisma, ctx, { friendlyId: "run_inEnv" });
      await createRun(
        prisma,
        { ...ctx, environmentId: otherEnvId },
        { friendlyId: "run_otherEnv" }
      );

      await setTimeout(1500);

      const resolver = new ClickHouseRunListResolver({
        getClickhouse: async () => clickhouse,
        prisma: throwingTaskRunFindMany(prisma),
      });

      const runIds = await resolver.resolveMatchingRunIds({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
        limit: 10,
      });

      expect(runIds).toEqual([inEnv.id]);
    }
  );
});
