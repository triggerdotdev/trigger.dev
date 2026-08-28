// FOUR-STORE MATRIX — proves RoutingRunStore is correct across legacy + new + two gen-2 shards
// (a, b) against REAL databases (makeNShardRunOpsPostgresTest). NEVER mocked. This is where the
// §3.4 disjoint-sum fix is proven end-to-end: a double count here strands a blocked run forever.
//
// runOpsStore.mixedResidency.test.ts is the TWO-store invariant lock and stays byte-identical; this
// file is the N-store extension and lives separately.

import { makeNShardRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { resolveShard } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

const matrixTest = makeNShardRunOpsPostgresTest(2);

// A gen-2 id: 24-char base32hex core, the shard char at index 24, version "2" at index 25.
// resolveShard(gen2("a", ...)) === "a". A bare cuid-length id classifies "legacy".
function gen2(shardChar: string, seed: string): string {
  const core = (seed.replace(/[^0-9a-v]/g, "0") + "k".repeat(24)).slice(0, 24);
  return `${core}${shardChar}2`;
}
function cuid(seed: string): string {
  return (seed + "c".repeat(25)).slice(0, 25); // 25 chars → LEGACY
}

function makeStore(prisma: AnyClient, variant: "legacy" | "dedicated") {
  return new PostgresRunStore({
    prisma: prisma as never,
    readOnlyPrisma: prisma as never,
    schemaVariant: variant,
  });
}

// The real four-store split: legacy (full schema) + new + gen-2 a + gen-2 b (dedicated subset),
// routed by the REAL core resolveShard.
function makeMatrixRouter(
  legacyPrisma: PrismaClient,
  newPrisma: RunOpsPrismaClient,
  shardPrismas: RunOpsPrismaClient[]
) {
  return new RoutingRunStore({
    new: makeStore(newPrisma, "dedicated"),
    legacy: makeStore(legacyPrisma, "legacy"),
    shards: [
      { key: "a", store: makeStore(shardPrismas[0]!, "dedicated") },
      { key: "b", store: makeStore(shardPrismas[1]!, "dedicated") },
    ],
    resolveShard,
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
  return {
    organizationId: organization.id,
    projectId: project.id,
    runtimeEnvironmentId: environment.id,
    environmentId: environment.id,
  };
}

function buildRun(params: {
  runId: string;
  runtimeEnvironmentId: string;
  organizationId: string;
  projectId: string;
  createdAt?: Date;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: `run_${params.runId}`,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      runTags: [],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: params.createdAt ?? new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

async function seedPendingWaitpoint(
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

describe("RoutingRunStore four-store matrix — disjoint sum on real databases", () => {
  matrixTest(
    "countPendingWaitpoints unions across a gen-2 shard and the gen-1 pair with no double count",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const env = await seedLegacyEnv(legacyPrisma, "disjoint");
      const router = makeMatrixRouter(legacyPrisma, newPrisma, shardPrismas);

      // The blocked run lives on shard a.
      const runId = gen2("a", "run");
      // Its blocking waitpoints: a gen-2 waitpoint on shard b, a cuid on legacy, and a cuid MIRRORED
      // onto both gen-1 stores (the drain-mirror case that must count once).
      const wpB = gen2("b", "wpb");
      const wpCuid = cuid("wpcuid");
      const wpMirror = cuid("wpmirror");

      const dedicatedEnv = { projectId: env.projectId, environmentId: env.environmentId };
      await seedPendingWaitpoint(shardPrismas[1]!, { id: wpB, ...dedicatedEnv });
      await seedPendingWaitpoint(legacyPrisma, { id: wpCuid, ...dedicatedEnv });
      await seedPendingWaitpoint(legacyPrisma, { id: wpMirror, ...dedicatedEnv });
      await seedPendingWaitpoint(newPrisma, { id: wpMirror, ...dedicatedEnv });

      // b:wpB (1) + legacy:wpCuid (1) + wpMirror (once, though on both gen-1 stores) = 3.
      const count = await router.countPendingWaitpoints([wpB, wpCuid, wpMirror], undefined, runId);
      expect(count).toBe(3);
    }
  );

  matrixTest(
    "a gen-2 waitpoint on the run's own shard contributes exactly once, not twice",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const env = await seedLegacyEnv(legacyPrisma, "ownshard");
      const router = makeMatrixRouter(legacyPrisma, newPrisma, shardPrismas);
      const runId = gen2("a", "run2");
      const wpA = gen2("a", "wpa");
      await seedPendingWaitpoint(shardPrismas[0]!, {
        id: wpA,
        projectId: env.projectId,
        environmentId: env.environmentId,
      });
      // wpA lives on the run's own shard a → found by the presence query, never re-queried elsewhere.
      expect(await router.countPendingWaitpoints([wpA], undefined, runId)).toBe(1);
    }
  );
});

describe("RoutingRunStore four-store matrix — alias topology", () => {
  matrixTest(
    "an aliased gen-2 shard counts its database ONCE in a sum (declaration, not identity)",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const env = await seedLegacyEnv(legacyPrisma, "alias");
      // Shard "a" aliases "new" over the SAME database, but via a SEPARATE store object built over
      // the same client — exactly how the wiring layer will construct it. Identity dedupe would see
      // two objects and double-count; declaration dedupe counts the database once.
      const newStore = makeStore(newPrisma, "dedicated");
      const aStoreSameDb = makeStore(newPrisma, "dedicated"); // distinct object, same DB
      const router = new RoutingRunStore({
        new: newStore,
        legacy: makeStore(legacyPrisma, "legacy"),
        shards: [{ key: "a", store: aStoreSameDb, aliasOf: "new" }],
        resolveShard,
      });

      const wp = cuid("aliaswp");
      await seedPendingWaitpoint(newPrisma, {
        id: wp,
        projectId: env.projectId,
        environmentId: env.environmentId,
      });
      // No runId → the id-less sum fans over DISTINCT databases. The aliased "a" must not add a
      // second leg over the "new" database, or the one pending waitpoint counts twice.
      expect(await router.countPendingWaitpoints([wp])).toBe(1);
    }
  );
});

describe("RoutingRunStore four-store matrix — mixed gen-1 and gen-2 reads", () => {
  matrixTest(
    "findRunsByIds hydrates a mixed id set across legacy, new and both gen-2 shards",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const env = await seedLegacyEnv(legacyPrisma, "mixed");
      const router = makeMatrixRouter(legacyPrisma, newPrisma, shardPrismas);

      const legacyId = cuid("mixleg");
      // A v1 run-ops id (version "1") routes to "new"; gen-2 ids route to their shard char.
      const newId = ("mixnew".replace(/[^0-9a-v]/g, "0") + "k".repeat(24)).slice(0, 24) + "01";
      const aId = gen2("a", "mixa");
      const bId = gen2("b", "mixb");
      const all = [legacyId, newId, aId, bId];

      for (const runId of all) {
        await router.createRun(buildRun({ runId, ...env }));
      }

      const found = await router.findRunsByIds(all, { select: { id: true } });
      expect(new Set([...found.keys()])).toEqual(new Set(all));
    }
  );
});

describe("RoutingRunStore four-store matrix — cross-tree completion across gen-2 shards", () => {
  matrixTest(
    "a gen-2 waitpoint completes on its own shard even under the cross-tree legacy pin",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const env = await seedLegacyEnv(legacyPrisma, "crosstree");
      const router = makeMatrixRouter(legacyPrisma, newPrisma, shardPrismas);
      // The waitpoint is owned by a run on shard b; the blocked run is on shard a (cross-tree).
      const wpB = gen2("b", "ctwp");
      await seedPendingWaitpoint(shardPrismas[1]!, {
        id: wpB,
        projectId: env.projectId,
        environmentId: env.environmentId,
      });
      // isCrossTreeIdempotency pins gen-1 flows to legacy; a gen-2 id must OVERRIDE that pin, or the
      // completion write lands on legacy, matches zero rows, and strands the run.
      const store = await router.forWaitpointCompletion(wpB, {
        isCrossTreeIdempotency: true,
      } as never);
      // The returned store finds wpB on its primary — only shard b holds it, so the override worked.
      const found = await store.findWaitpoint({ where: { id: wpB } }, store.primaryReadClient);
      expect(found?.id).toBe(wpB);
    }
  );
});

describe("RoutingRunStore four-store matrix — pagination merge", () => {
  matrixTest(
    "findRuns merges an open-predicate page across all four stores in orderBy order",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const env = await seedLegacyEnv(legacyPrisma, "paginate");
      const router = makeMatrixRouter(legacyPrisma, newPrisma, shardPrismas);
      // One run per store, distinct createdAt so the global sort order is unambiguous.
      const rows = [
        { id: cuid("pgleg"), at: new Date("2024-01-01T00:00:00Z") },
        {
          id: ("pgnew".replace(/[^0-9a-v]/g, "0") + "k".repeat(24)).slice(0, 24) + "01",
          at: new Date("2024-01-02T00:00:00Z"),
        },
        { id: gen2("a", "pga"), at: new Date("2024-01-03T00:00:00Z") },
        { id: gen2("b", "pgb"), at: new Date("2024-01-04T00:00:00Z") },
      ];
      for (const r of rows) {
        await router.createRun(buildRun({ runId: r.id, ...env, createdAt: r.at }));
      }
      // Open predicate (no id set) → fan out + merge; take 2 skip 1 over createdAt desc.
      const page = (await router.findRuns({
        where: { runtimeEnvironmentId: env.runtimeEnvironmentId },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 2,
        skip: 1,
      })) as Array<{ id: string }>;
      // Global desc order is b, a, new, legacy; skip 1 take 2 → [a, new].
      expect(page.map((r) => r.id)).toEqual([rows[2]!.id, rows[1]!.id]);
    }
  );
});

// A misplaced tag row still reads back, because the read fans out, so only a per-database count
// can see it. Hence containers rather than the fake-store suite.
describe("four-store matrix — a waitpoint tag lands on its environment's shard", () => {
  matrixTest(
    "the shard key routes the tag to shard a, and no gen-1 store receives it",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const router = makeMatrixRouter(legacyPrisma, newPrisma, shardPrismas);
      const env = await seedLegacyEnv(legacyPrisma, "tag_shard_a");

      await router.upsertWaitpointTag(
        { environmentId: env.environmentId, name: "tag-on-a", projectId: env.projectId },
        undefined,
        "NEW",
        "a"
      );

      expect(await shardPrismas[0]!.waitpointTag.count({ where: { name: "tag-on-a" } })).toBe(1);
      expect(await newPrisma.waitpointTag.count({ where: { name: "tag-on-a" } })).toBe(0);
      expect(await legacyPrisma.waitpointTag.count({ where: { name: "tag-on-a" } })).toBe(0);
      expect(await shardPrismas[1]!.waitpointTag.count({ where: { name: "tag-on-a" } })).toBe(0);
    }
  );

  matrixTest(
    "two environments on different shards do not share a database",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const router = makeMatrixRouter(legacyPrisma, newPrisma, shardPrismas);
      const envA = await seedLegacyEnv(legacyPrisma, "tag_two_a");
      const envB = await seedLegacyEnv(legacyPrisma, "tag_two_b");

      await router.upsertWaitpointTag(
        { environmentId: envA.environmentId, name: "shared-name", projectId: envA.projectId },
        undefined,
        "NEW",
        "a"
      );
      await router.upsertWaitpointTag(
        { environmentId: envB.environmentId, name: "shared-name", projectId: envB.projectId },
        undefined,
        "NEW",
        "b"
      );

      // The constraint is per-database, so a collapse still inserts two rows: this catches
      // placement, not a constraint violation.
      const onA = await shardPrismas[0]!.waitpointTag.findMany({ where: { name: "shared-name" } });
      const onB = await shardPrismas[1]!.waitpointTag.findMany({ where: { name: "shared-name" } });
      expect(onA.map((r) => r.environmentId)).toEqual([envA.environmentId]);
      expect(onB.map((r) => r.environmentId)).toEqual([envB.environmentId]);
      expect(await newPrisma.waitpointTag.count({ where: { name: "shared-name" } })).toBe(0);
    }
  );

  matrixTest(
    "with no shard key the tag still routes by residency, exactly as before",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const router = makeMatrixRouter(legacyPrisma, newPrisma, shardPrismas);
      const env = await seedLegacyEnv(legacyPrisma, "tag_gen1");

      await router.upsertWaitpointTag(
        { environmentId: env.environmentId, name: "tag-gen1", projectId: env.projectId },
        undefined,
        "NEW"
      );

      expect(await newPrisma.waitpointTag.count({ where: { name: "tag-gen1" } })).toBe(1);
      expect(await shardPrismas[0]!.waitpointTag.count({ where: { name: "tag-gen1" } })).toBe(0);
    }
  );

  matrixTest(
    "a tag written to a shard is found by the read fan-out",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const router = makeMatrixRouter(legacyPrisma, newPrisma, shardPrismas);
      const env = await seedLegacyEnv(legacyPrisma, "tag_readback");

      await router.upsertWaitpointTag(
        { environmentId: env.environmentId, name: "tag-readback", projectId: env.projectId },
        undefined,
        "NEW",
        "a"
      );

      const found = await router.findManyWaitpointTags({
        where: { environmentId: env.environmentId },
      });
      expect(found.map((r) => r.name)).toEqual(["tag-readback"]);
    }
  );

  // What a rollout produces: tags exist, then the environment is pinned.
  matrixTest(
    "the same tag name on a gen-1 store and a shard is listed once",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const router = makeMatrixRouter(legacyPrisma, newPrisma, shardPrismas);
      const env = await seedLegacyEnv(legacyPrisma, "tag_dupe");

      await router.upsertWaitpointTag(
        { environmentId: env.environmentId, name: "prod", projectId: env.projectId },
        undefined,
        "NEW"
      );
      await router.upsertWaitpointTag(
        { environmentId: env.environmentId, name: "prod", projectId: env.projectId },
        undefined,
        "NEW",
        "a"
      );

      const onNew = await newPrisma.waitpointTag.findMany({ where: { name: "prod" } });
      const onShard = await shardPrismas[0]!.waitpointTag.findMany({ where: { name: "prod" } });
      expect(onNew).toHaveLength(1);
      expect(onShard).toHaveLength(1);
      expect(onNew[0]!.id).not.toBe(onShard[0]!.id);

      const found = await router.findManyWaitpointTags({
        where: { environmentId: env.environmentId },
      });
      expect(found.map((r) => r.name)).toEqual(["prod"]);
    }
  );

  matrixTest(
    "two environments keep their own tag of the same name",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const router = makeMatrixRouter(legacyPrisma, newPrisma, shardPrismas);
      const envA = await seedLegacyEnv(legacyPrisma, "tag_dupe_a");
      const envB = await seedLegacyEnv(legacyPrisma, "tag_dupe_b");

      await router.upsertWaitpointTag(
        { environmentId: envA.environmentId, name: "prod", projectId: envA.projectId },
        undefined,
        "NEW",
        "a"
      );
      await router.upsertWaitpointTag(
        { environmentId: envB.environmentId, name: "prod", projectId: envB.projectId },
        undefined,
        "NEW",
        "b"
      );

      // No environment filter, or each result set holds one row and a name-only key would pass.
      const both = await router.findManyWaitpointTags({ where: { name: "prod" } });

      expect(both.map((r) => r.environmentId).sort()).toEqual(
        [envA.environmentId, envB.environmentId].sort()
      );
    }
  );
});
