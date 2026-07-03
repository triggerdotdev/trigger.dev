import { describe, expect, vi } from "vitest";

// The runsRepository module graph imports `~/v3/runStore.server`, which imports `~/db.server`
// at load. Stub it (the existing runsRepository.part*.test.ts do the same) — the repo under test
// is driven entirely through injected real containers, never the stubbed module singletons.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { PostgresRunStore } from "@internal/run-store";
import { createPostgresContainer, replicationContainerTest } from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { setupClickhouseReplication } from "./utils/replicationUtils";

vi.setConfig({ testTimeout: 90_000 });

type SeedContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

/**
 * Creates the org/project/env parents on a single prisma client. TaskRun FKs require
 * these to exist on every DB a run is hydrated from, so we seed identical parents
 * (same ids) on both the legacy (PG14) and new (PG17) databases.
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
  run: {
    id?: string;
    friendlyId: string;
    taskIdentifier?: string;
    status?: any;
    runTags?: string[];
    createdAt?: Date;
  }
) {
  return prisma.taskRun.create({
    data: {
      ...(run.id ? { id: run.id } : {}),
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
      ...(run.createdAt ? { createdAt: run.createdAt } : {}),
    },
  });
}

describe("RunsRepository read-through id-set hydrate (PG14 legacy + PG17 new)", () => {
  // --- DoD line + e2e #6: split fan-out across new + legacy-replica with known-migrated filter ---
  replicationContainerTest(
    "split mode hydrates the CH id-set as the union of NEW + legacy-replica rows, byte-identical and id-desc ordered",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma, network }) => {
      // The fixture's PG14 container is the LEGACY read replica AND the replication source that
      // feeds the ClickHouse id-set. The dedicated PG17 container is the NEW run-ops DB.
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

      try {
        const ctx = await seedParents(prisma, "split1");
        await mirrorParents(prismaNew, ctx, "split1");

        // Seed all four runs on PG14 (legacy + replication source -> CH gets the full id-set).
        const legacyOnlyA = await createRun(prisma, ctx, { friendlyId: "run_legacyA" });
        const legacyOnlyB = await createRun(prisma, ctx, { friendlyId: "run_legacyB" });
        const migratedA = await createRun(prisma, ctx, { friendlyId: "run_newA" });
        const migratedB = await createRun(prisma, ctx, { friendlyId: "run_newB" });

        // The two "migrated" runs ALSO live on the NEW DB (authoritative during retention).
        // Same ids so set-membership and ordering line up with the CH id-set.
        await createRun(prismaNew, { ...ctx }, { friendlyId: "run_newA" });
        await createRun(prismaNew, { ...ctx }, { friendlyId: "run_newB" });
        // Force the NEW rows to share the legacy ids exactly.
        await prismaNew.taskRun.update({
          where: { friendlyId: "run_newA" },
          data: { id: migratedA.id },
        });
        await prismaNew.taskRun.update({
          where: { friendlyId: "run_newB" },
          data: { id: migratedB.id },
        });

        await setTimeout(1500);

        const runsRepository = new RunsRepository({
          prisma, // single-DB default handle (unused on the split path here)
          clickhouse,
          runStore: new PostgresRunStore({ prisma: prismaNew, readOnlyPrisma: prismaNew }),
          readThrough: {
            splitEnabled: true,
            newClient: prismaNew,
            legacyReplica: prisma,
          },
        });

        const { runs } = await runsRepository.listRuns({
          page: { size: 10 },
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
          organizationId: ctx.organizationId,
        });

        // Union of all four, id-desc ordered.
        const expectedIds = [migratedA.id, migratedB.id, legacyOnlyA.id, legacyOnlyB.id].sort(
          (a, b) => (a < b ? 1 : a > b ? -1 : 0)
        );
        expect(runs.map((r) => r.id)).toEqual(expectedIds);

        // Byte-identity for a NEW-served row (from PG17) and a legacy-served row (from PG14).
        const newRow = runs.find((r) => r.id === migratedA.id)!;
        expect(newRow.friendlyId).toBe("run_newA");
        expect(newRow.taskIdentifier).toBe("my-task");
        const legacyRow = runs.find((r) => r.id === legacyOnlyA.id)!;
        expect(legacyRow.friendlyId).toBe("run_legacyA");

        // Order parity with single-DB: a pure id-desc sort of the same ids.
        expect(runs.map((r) => r.id)).toEqual(
          [...runs.map((r) => r.id)].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
        );
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );

  // --- Passthrough (single-DB): one plain store read, legacy never touched ---
  replicationContainerTest(
    "single-DB passthrough hydrates from one store read and never touches the legacy boundary",
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

      // splitEnabled false → the split branch is never entered (one plain store read).
      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
        readThrough: {
          splitEnabled: false,
          legacyReplica: prisma,
        },
      });

      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
        organizationId: ctx.organizationId,
      });

      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe(run.id);

      const friendlyIds = await runsRepository.listFriendlyRunIds({
        page: { size: 10 },
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
        organizationId: ctx.organizationId,
      });
      expect(friendlyIds).toEqual(["run_passthrough"]);
    }
  );

  // --- Ordering: the hydrated page follows the ClickHouse keyset (created_at desc), NOT raw id ---
  replicationContainerTest(
    "listRuns orders by the ClickHouse created_at keyset, not by raw id",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const ctx = await seedParents(prisma, "ordering");
      // Make chronological order the OPPOSITE of id order: the run created FIRST (smaller
      // time-prefixed cuid id) is given the MOST-RECENT created_at. A correct list returns
      // [mostRecent, oldest] (created_at desc); the old id-desc hydrate would invert it.
      // created_at is set at insert time (not via update) so ClickHouse never holds a second
      // ReplacingMergeTree version that could surface as a duplicate.
      const now = Date.now();
      const mostRecent = await createRun(prisma, ctx, {
        friendlyId: "run_orderA",
        createdAt: new Date(now),
      });
      const oldest = await createRun(prisma, ctx, {
        friendlyId: "run_orderB",
        createdAt: new Date(now - 3_600_000),
      });
      expect(mostRecent.id < oldest.id).toBe(true); // raw id-desc would yield [oldest, mostRecent]

      await setTimeout(1500);

      const runsRepository = new RunsRepository({ prisma, clickhouse });
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
        organizationId: ctx.organizationId,
      });

      expect(runs.map((r) => r.id)).toEqual([mostRecent.id, oldest.id]);
    }
  );

  // --- listFriendlyRunIds parity: split union, id projected away to a plain string[] ---
  replicationContainerTest(
    "listFriendlyRunIds returns the union of friendly ids across new + legacy, projecting id away",
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

      try {
        const ctx = await seedParents(prisma, "friendly");
        await mirrorParents(prismaNew, ctx, "friendly");

        const legacy = await createRun(prisma, ctx, { friendlyId: "run_fLegacy" });
        const migrated = await createRun(prisma, ctx, { friendlyId: "run_fNew" });
        await createRun(prismaNew, ctx, { friendlyId: "run_fNew" });
        await prismaNew.taskRun.update({
          where: { friendlyId: "run_fNew" },
          data: { id: migrated.id },
        });

        await setTimeout(1500);

        const runsRepository = new RunsRepository({
          prisma,
          clickhouse,
          runStore: new PostgresRunStore({ prisma: prismaNew, readOnlyPrisma: prismaNew }),
          readThrough: {
            splitEnabled: true,
            newClient: prismaNew,
            legacyReplica: prisma,
          },
        });

        const friendlyIds = await runsRepository.listFriendlyRunIds({
          page: { size: 10 },
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
          organizationId: ctx.organizationId,
        });

        expect(friendlyIds.every((f) => typeof f === "string")).toBe(true);
        expect([...friendlyIds].sort()).toEqual(["run_fLegacy", "run_fNew"]);
        // id projected away: a friendlyId is never a run internal id.
        expect(friendlyIds).not.toContain(legacy.id);
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );

  // Full-keyset walk over interleaved cuid + ksuid ids: hydration must preserve the ClickHouse
  // (created_at DESC, run_id DESC) order across the id-space seam. A hydrate that reverts to lexical
  // `id desc` splits the two id-spaces into separate blocks, so it would fail this walk.
  replicationContainerTest(
    "paginating the full keyset enumerates every interleaved cuid/ksuid id once, in CH keyset order, with no empty page",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const ctx = await seedParents(prisma, "keysetwalk");

      // cuid-shaped ids (25 chars, "c" prefix) and ksuid-shaped ids (27 chars, "2" prefix). Lexical
      // `id desc` groups all "c" ids ahead of all "2" ids; the created_at order below interleaves
      // them, so the two orders genuinely differ across the seam.
      const cuid = (n: number) => `c${String(n).padStart(24, "0")}`;
      const ksuid = (n: number) => `2${String(n).padStart(26, "0")}`;

      // created_at DESC order (index 0 = most recent) interleaves the id-spaces: ksuid, cuid,
      // ksuid, cuid, ksuid, cuid.
      const now = Date.now();
      const seeds = [
        { id: ksuid(6), friendlyId: "run_k6", createdAt: new Date(now - 0 * 60_000) },
        { id: cuid(5), friendlyId: "run_c5", createdAt: new Date(now - 1 * 60_000) },
        { id: ksuid(4), friendlyId: "run_k4", createdAt: new Date(now - 2 * 60_000) },
        { id: cuid(3), friendlyId: "run_c3", createdAt: new Date(now - 3 * 60_000) },
        { id: ksuid(2), friendlyId: "run_k2", createdAt: new Date(now - 4 * 60_000) },
        { id: cuid(1), friendlyId: "run_c1", createdAt: new Date(now - 5 * 60_000) },
      ];
      for (const s of seeds) {
        await createRun(prisma, ctx, s);
      }

      await setTimeout(1500);

      const runsRepository = new RunsRepository({ prisma, clickhouse });

      // The authoritative order the hydrate must reproduce: exactly the CH keyset the id-list scan
      // returns (created_at DESC, run_id DESC). Lexical id-desc of the same ids differs from this.
      const chOrder = await runsRepository.listRunIds({
        page: { size: 100 },
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
        organizationId: ctx.organizationId,
      });
      const expectedOrder = chOrder.runIds;
      const lexicalIdDesc = [...expectedOrder].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      expect(expectedOrder).not.toEqual(lexicalIdDesc); // the seam actually separates the two orders

      // Walk the whole keyset a page at a time.
      const walked: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      while (true) {
        const { runs, pagination } = await runsRepository.listRuns({
          page: { size: 2, cursor },
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
          organizationId: ctx.organizationId,
        });
        pages++;
        expect(pages).toBeLessThan(20); // guard against a non-terminating walk

        for (const r of runs) walked.push(r.id);

        if (!pagination.nextCursor) break;
        // No empty page may be returned while more pages exist.
        expect(runs.length).toBeGreaterThan(0);
        cursor = pagination.nextCursor;
      }

      // Every seeded id enumerated exactly once.
      expect(walked.slice().sort()).toEqual(seeds.map((s) => s.id).sort());
      expect(new Set(walked).size).toBe(seeds.length);
      // The emitted order equals the CH keyset order across the id-space seam.
      expect(walked).toEqual(expectedOrder);
    }
  );
});
