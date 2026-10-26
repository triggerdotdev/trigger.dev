// An id-less lookup legitimately returns a DIFFERENT row from each store. Above two stores the
// probe runs every leg, and only one id seen on two stores is a duplicate.

import { makeNShardRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { resolveShard } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { RoutingStoreMetrics } from "./routingStoreMetrics.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

const threeStoreTest = makeNShardRunOpsPostgresTest(1);

function gen2(shardChar: string, seed: string): string {
  const core = (seed.replace(/[^0-9a-v]/g, "0") + "k".repeat(24)).slice(0, 24);
  return `${core}${shardChar}2`;
}
const cuid = (seed: string) => (seed + "c".repeat(25)).slice(0, 25);
const runOpsNew = (seed: string) =>
  (seed.replace(/[^0-9a-v]/g, "0") + "k".repeat(24)).slice(0, 24) + "01";

function makeStore(prisma: AnyClient, variant: "legacy" | "dedicated") {
  return new PostgresRunStore({
    prisma: prisma as never,
    readOnlyPrisma: prisma as never,
    schemaVariant: variant,
  });
}

function recordingMetrics() {
  const duplicates: string[][] = [];
  const metrics: RoutingStoreMetrics = {
    recordDuplicateId: (shardKeys) => duplicates.push(shardKeys),
    recordWaitpointProbeFallback() {},
    recordShardRouted() {},
  };
  return { metrics, duplicates };
}

function makeRouter(
  legacyPrisma: PrismaClient,
  newPrisma: RunOpsPrismaClient,
  shardPrismas: RunOpsPrismaClient[],
  metrics: RoutingStoreMetrics
) {
  return new RoutingRunStore({
    new: makeStore(newPrisma, "dedicated"),
    legacy: makeStore(legacyPrisma, "legacy"),
    shards: [{ key: "a", store: makeStore(shardPrismas[0]!, "dedicated") }],
    resolveShard,
    metrics,
  });
}

async function seedLegacyEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { projectId: project.id, environmentId: environment.id };
}

async function seedManualWaitpoint(
  prisma: AnyClient,
  params: { id: string; projectId: string; environmentId: string }
) {
  await (prisma as PrismaClient).waitpoint.create({
    data: {
      id: params.id,
      friendlyId: `wp_${params.id}`,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: `idem_${params.id}`,
      userProvidedIdempotencyKey: false,
      projectId: params.projectId,
      environmentId: params.environmentId,
    },
  });
}

describe("RoutingRunStore id-less probe — duplicate alarm across three stores", () => {
  threeStoreTest(
    "a different MANUAL waitpoint on each store is not a duplicate",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const env = await seedLegacyEnv(legacyPrisma, "probe_distinct");
      const { metrics, duplicates } = recordingMetrics();
      const router = makeRouter(legacyPrisma, newPrisma, shardPrismas, metrics);

      const onLegacy = cuid("pdleg");
      const onNew = runOpsNew("pdnew");
      const onA = gen2("a", "pda");
      await seedManualWaitpoint(legacyPrisma, { id: onLegacy, ...env });
      await seedManualWaitpoint(newPrisma, { id: onNew, ...env });
      await seedManualWaitpoint(shardPrismas[0]!, { id: onA, ...env });

      // WaitpointListPresenter's "any token in this environment" probe.
      const found = await router.findWaitpoint({
        where: { environmentId: env.environmentId, type: "MANUAL" },
      });

      // The highest-precedence hit (gen-2 shard a) still wins.
      expect(found?.id).toBe(onA);
      expect(duplicates).toEqual([]);
    }
  );

  threeStoreTest(
    "one id on new and on shard a alarms once, for those two stores",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const env = await seedLegacyEnv(legacyPrisma, "probe_dup");
      const { metrics, duplicates } = recordingMetrics();
      const router = makeRouter(legacyPrisma, newPrisma, shardPrismas, metrics);

      const dup = gen2("a", "pddup");
      await seedManualWaitpoint(legacyPrisma, { id: cuid("pddupleg"), ...env });
      await seedManualWaitpoint(newPrisma, { id: dup, ...env });
      await seedManualWaitpoint(shardPrismas[0]!, { id: dup, ...env });

      const found = await router.findWaitpoint({
        where: { environmentId: env.environmentId, type: "MANUAL" },
      });

      expect(found?.id).toBe(dup);
      expect(duplicates).toEqual([["new", "a"]]);
    }
  );

  threeStoreTest(
    "a hit whose projection has no id is not compared and does not alarm",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const env = await seedLegacyEnv(legacyPrisma, "probe_noid");
      const { metrics, duplicates } = recordingMetrics();
      const router = makeRouter(legacyPrisma, newPrisma, shardPrismas, metrics);

      const onA = gen2("a", "pna");
      await seedManualWaitpoint(legacyPrisma, { id: cuid("pnleg"), ...env });
      await seedManualWaitpoint(shardPrismas[0]!, { id: onA, ...env });

      // Legacy honours the projection and returns no id; the dedicated store still hydrates one.
      const found = await router.findWaitpoint({
        where: { environmentId: env.environmentId, type: "MANUAL" },
        select: { type: true },
      });

      // `id` is forced into the narrowed select by PostgresRunStore's stripDedicatedRelations.
      expect(found).toEqual({ id: onA, type: "MANUAL" });
      expect(duplicates).toEqual([]);
    }
  );
});
