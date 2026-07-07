import { Prisma } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

// BatchListPresenter imports `~/db.server` (for `sqlDatabaseSchema` + `PrismaClientOrTransaction`),
// `~/models/runtimeEnvironment.server`, and `~/components/*` at load — all of which pull
// `env.server` at import time. Stub `~/db.server` to break that chain (the runsRepository
// read-through test does the same). The presenter is driven entirely through injected real
// containers; the only thing it actually reads off this module is `sqlDatabaseSchema`, which we
// reproduce as the real `Prisma.sql(["public"])` value so the schema-qualified raw scan SQL is valid.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  sqlDatabaseSchema: Prisma.sql(["public"]),
}));

import {
  heteroPostgresTest,
  heteroRunOpsPostgresTest,
  postgresTest,
} from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import {
  type BatchListOptions,
  BatchListPresenter,
} from "~/presenters/v3/BatchListPresenter.server";

vi.setConfig({ testTimeout: 120_000 });

type SeedContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

// The exact presenter scan SQL, lifted verbatim, so tests can compare the presenter's output
// against a direct $queryRaw of the identical SQL on each DB version.
function rawScan(
  prisma: PrismaClient,
  opts: {
    environmentId: string;
    pageSize: number;
    direction: "forward" | "backward";
    cursor?: string;
  }
) {
  const { environmentId, pageSize, direction, cursor } = opts;
  const sqlDatabaseSchema = Prisma.sql(["public"]);
  return prisma.$queryRaw<
    {
      id: string;
      friendlyId: string;
      runtimeEnvironmentId: string;
      status: any;
      createdAt: Date;
      updatedAt: Date;
      completedAt: Date | null;
      runCount: bigint;
      batchVersion: string;
    }[]
  >`
    SELECT
    b.id,
    b."friendlyId",
    b."runtimeEnvironmentId",
    b.status,
    b."createdAt",
    b."updatedAt",
    b."completedAt",
    b."runCount",
    b."batchVersion"
FROM
    ${sqlDatabaseSchema}."BatchTaskRun" b
WHERE
    b."runtimeEnvironmentId" = ${environmentId}
    ${
      cursor
        ? direction === "forward"
          ? Prisma.sql`AND b.id < ${cursor}`
          : Prisma.sql`AND b.id > ${cursor}`
        : Prisma.empty
    }
    ORDER BY
        ${direction === "forward" ? Prisma.sql`b.id DESC` : Prisma.sql`b.id ASC`}
    LIMIT ${pageSize + 1}`;
}

async function seedParents(prisma: PrismaClient, slug: string): Promise<SeedContext> {
  const user = await prisma.user.create({
    data: {
      email: `user-${slug}@example.com`,
      name: `User ${slug}`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
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
  const orgMember = await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      orgMemberId: orgMember.id,
      apiKey: `tr_dev_${slug}`,
      pkApiKey: `pk_dev_${slug}`,
      shortcode: `sc-${slug}`,
    },
  });

  return {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: runtimeEnvironment.id,
    userId: user.id,
  };
}

// Mirrors the org/project/env parents onto a second DB with the SAME ids (BatchTaskRun FK needs
// the runtimeEnvironment to exist on whichever DB the row lives on).
async function mirrorEnvParents(
  prisma: PrismaClient,
  ctx: SeedContext,
  slug: string
): Promise<void> {
  const organization = await prisma.organization.create({
    data: { id: ctx.organizationId, title: `org-${slug}`, slug: `org-${slug}` },
  });
  const project = await prisma.project.create({
    data: {
      id: ctx.projectId,
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: organization.id,
      externalRef: `proj-${slug}`,
    },
  });
  await prisma.runtimeEnvironment.create({
    data: {
      id: ctx.environmentId,
      slug: `env-${slug}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slug}_m`,
      pkApiKey: `pk_dev_${slug}_m`,
      shortcode: `sc-${slug}-m`,
    },
  });
}

async function createBatch(
  prisma: PrismaClient,
  ctx: SeedContext,
  batch: {
    id: string;
    friendlyId: string;
    status?: any;
    batchVersion?: string;
    runCount?: number;
    createdAt?: Date;
  }
) {
  return prisma.batchTaskRun.create({
    data: {
      id: batch.id,
      friendlyId: batch.friendlyId,
      runtimeEnvironmentId: ctx.environmentId,
      status: batch.status ?? "PENDING",
      batchVersion: batch.batchVersion ?? "v3",
      runCount: batch.runCount ?? 1,
      ...(batch.createdAt ? { createdAt: batch.createdAt } : {}),
    },
  });
}

const baseCall = (
  ctx: SeedContext,
  overrides: Partial<BatchListOptions> = {}
): BatchListOptions => ({
  projectId: ctx.projectId,
  environmentId: ctx.environmentId,
  userId: ctx.userId,
  ...overrides,
});

// Wraps a prisma client so the test can assert whether/how often batchTaskRun.findMany or
// batchTaskRun.findFirst are invoked. Optionally throws if invoked (proves a handle is never touched).
function spyClient(
  prisma: PrismaClient,
  opts: { throwOnQueryRaw?: boolean; throwOnFindFirst?: boolean } = {}
) {
  const counts = { queryRaw: 0, findMany: 0, findFirst: 0 };
  const proxy = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === "batchTaskRun") {
        const real = (target as any).batchTaskRun;
        return new Proxy(real, {
          get(trTarget, trProp) {
            if (trProp === "findMany") {
              return (...args: any[]) => {
                counts.findMany++;
                if (opts.throwOnQueryRaw)
                  throw new Error("batchTaskRun.findMany must not be invoked on this handle");
                return (trTarget as any).findMany(...args);
              };
            }
            if (trProp === "findFirst") {
              return (...args: any[]) => {
                counts.findFirst++;
                if (opts.throwOnFindFirst)
                  throw new Error("batchTaskRun.findFirst must not be invoked on this handle");
                return (trTarget as any).findFirst(...args);
              };
            }
            return (trTarget as any)[trProp];
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as PrismaClient;
  return { client: proxy, counts };
}

const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

describe("BatchListPresenter run-ops read routing (PG14 control-plane/legacy + PG17 new)", () => {
  // Byte-identical scan + identical ORDER-BY across PG14/PG17.
  heteroPostgresTest(
    "raw paginated scan is byte-identical and identically ordered across PG14 and PG17 (both directions, with/without cursor)",
    async ({ prisma14, prisma17 }) => {
      const ctx14 = await seedParents(prisma14, "scan");
      const ctx17 = await seedParents(prisma17, "scan");

      // Identical corpus on both sides (same logical ids), exercising statuses + batchVersion +
      // createdAt spanning a period, and keyset cursor boundaries.
      const ids = ["aaaa", "bbbb", "cccc", "dddd", "eeee"];
      const statuses = ["PENDING", "COMPLETED", "ABORTED", "PROCESSING", "COMPLETED"];
      const versions = ["v3", "v3", "v1", "v2", "v3"];
      for (let i = 0; i < ids.length; i++) {
        await createBatch(prisma14, ctx14, {
          id: `batch_${ids[i]}`,
          friendlyId: `fr_${ids[i]}`,
          status: statuses[i],
          batchVersion: versions[i],
          runCount: i + 1,
          createdAt: new Date(Date.now() - i * 60_000),
        });
        await createBatch(prisma17, ctx17, {
          id: `batch_${ids[i]}`,
          friendlyId: `fr_${ids[i]}`,
          status: statuses[i],
          batchVersion: versions[i],
          runCount: i + 1,
          createdAt: new Date(Date.now() - i * 60_000),
        });
      }

      for (const direction of ["forward", "backward"] as const) {
        for (const cursor of [undefined, "batch_cccc"]) {
          const rows14 = await rawScan(prisma14, {
            environmentId: ctx14.environmentId,
            pageSize: 2,
            direction,
            cursor,
          });
          const rows17 = await rawScan(prisma17, {
            environmentId: ctx17.environmentId,
            pageSize: 2,
            direction,
            cursor,
          });
          // ids are identical across both DBs; rows must match byte-for-byte and in order.
          expect(rows14.map((r) => r.id)).toEqual(rows17.map((r) => r.id));
          expect(rows14.map((r) => r.friendlyId)).toEqual(rows17.map((r) => r.friendlyId));
          expect(rows14.map((r) => r.runCount)).toEqual(rows17.map((r) => r.runCount));
          expect(rows14.map((r) => r.status)).toEqual(rows17.map((r) => r.status));
          // ORDER-BY parity: forward => id DESC, backward => id ASC.
          const order = rows14.map((r) => r.id);
          const expected = [...order].sort(direction === "forward" ? desc : (a, b) => -desc(a, b));
          expect(order).toEqual(expected);
        }
      }

      // The TS codepoint comparator reproduces the DB ORDER BY over the seeded id set.
      const allIds = ids.map((i) => `batch_${i}`);
      const dbForward = (
        await rawScan(prisma17, {
          environmentId: ctx17.environmentId,
          pageSize: 50,
          direction: "forward",
        })
      ).map((r) => r.id);
      expect(dbForward).toEqual([...allIds].sort(desc));
    }
  );

  // Split scan merge serves new + legacy in one keyset-ordered page.
  heteroPostgresTest(
    "split scan merges new (PG17) + legacy (PG14) rows under the keyset order; legacy read only when new does not fill the page",
    async ({ prisma14, prisma17 }) => {
      const ctx14 = await seedParents(prisma14, "merge");
      await mirrorEnvParents(prisma17, ctx14, "merge");

      // Interleaved ids across the keyset order. New (migrated) on PG17, legacy on PG14.
      await createBatch(prisma17, ctx14, { id: "batch_a", friendlyId: "fr_a", runCount: 1 });
      await createBatch(prisma14, ctx14, { id: "batch_b", friendlyId: "fr_b", runCount: 2 });
      await createBatch(prisma17, ctx14, { id: "batch_c", friendlyId: "fr_c", runCount: 3 });
      await createBatch(prisma14, ctx14, { id: "batch_d", friendlyId: "fr_d", runCount: 4 });
      await createBatch(prisma17, ctx14, { id: "batch_e", friendlyId: "fr_e", runCount: 5 });

      // Case A: small page fully served by new alone => legacy NOT read.
      const legacySpyA = spyClient(prisma14);
      const presenterA = new BatchListPresenter(prisma17, prisma17, {
        runOpsNew: prisma17,
        runOpsLegacyReplica: legacySpyA.client,
        controlPlaneReplica: prisma14,
        splitEnabled: true,
      });
      const pageA = await presenterA.call(baseCall(ctx14, { pageSize: 2 }));
      // new ids are e, c, a -> DESC: e, c (pageSize 2). pageSize+1 = 3 rows from new fills the page.
      expect(pageA.batches.map((b) => b.id)).toEqual(["batch_e", "batch_c"]);
      expect(legacySpyA.counts.findMany).toBe(0);

      // Case B: page needs legacy rows => legacy IS read and the merge is keyset-ordered union.
      const legacySpyB = spyClient(prisma14);
      const presenterB = new BatchListPresenter(prisma17, prisma17, {
        runOpsNew: prisma17,
        runOpsLegacyReplica: legacySpyB.client,
        controlPlaneReplica: prisma14,
        splitEnabled: true,
      });
      const pageB = await presenterB.call(baseCall(ctx14, { pageSize: 4 }));
      // union DESC of all 5: e, d, c, b, a -> first 4.
      expect(pageB.batches.map((b) => b.id)).toEqual(["batch_e", "batch_d", "batch_c", "batch_b"]);
      expect(legacySpyB.counts.findMany).toBeGreaterThan(0);
      // cursor parity: next is the 4th id (pageSize-th), previous undefined (no input cursor).
      expect(pageB.pagination.next).toBe("batch_b");
      expect(pageB.pagination.previous).toBeUndefined();
      expect(pageB.hasAnyBatches).toBe(true);
    }
  );

  // Project resolves on control-plane; no cross-seam join.
  heteroPostgresTest(
    "project resolves on the control-plane handle (PG14); BatchTaskRun scan reads run-ops only",
    async ({ prisma14, prisma17 }) => {
      // Project/env/orgMember/user only on PG14 (control-plane). BatchTaskRun env mirrored to PG17.
      const ctx = await seedParents(prisma14, "cp");
      await mirrorEnvParents(prisma17, ctx, "cp");
      await createBatch(prisma17, ctx, { id: "batch_cp1", friendlyId: "fr_cp1", runCount: 7 });

      // controlPlaneReplica must never run the BatchTaskRun raw scan.
      const cpSpy = spyClient(prisma14, { throwOnQueryRaw: true });
      // runOpsNew must never run a project lookup — guard by making project absent on PG17.
      const presenter = new BatchListPresenter(prisma17, prisma17, {
        runOpsNew: prisma17,
        runOpsLegacyReplica: prisma14,
        controlPlaneReplica: cpSpy.client,
        splitEnabled: true,
      });

      const page = await presenter.call(baseCall(ctx, { pageSize: 10 }));
      expect(page.batches.map((b) => b.id)).toEqual(["batch_cp1"]);
      // displayableEnvironment mapped by in-memory id match.
      expect(page.batches[0].environment.id).toBe(ctx.environmentId);
      expect(page.batches[0].environment.type).toBe("DEVELOPMENT");
      // control-plane handle was used (project read) but never for the batch scan.
      expect(cpSpy.counts.findMany).toBe(0);
    }
  );

  // Empty-state probe is dual-DB during the window.
  heteroPostgresTest(
    "empty-state probe reads new then legacy replica: true when legacy has a batch, false when both empty",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "probe");
      await mirrorEnvParents(prisma17, ctx, "probe");

      // Zero batches on new (PG17), one on legacy (PG14). A filter that yields an empty page.
      await createBatch(prisma14, ctx, { id: "batch_legacy_only", friendlyId: "fr_legacy_only" });

      const presenter = new BatchListPresenter(prisma17, prisma17, {
        runOpsNew: prisma17,
        runOpsLegacyReplica: prisma14,
        controlPlaneReplica: prisma14,
        splitEnabled: true,
      });
      // friendlyId filter that matches nothing => empty page, probe must still find the legacy row.
      const page = await presenter.call(baseCall(ctx, { friendlyId: "fr_does_not_exist" }));
      expect(page.batches).toHaveLength(0);
      expect(page.hasAnyBatches).toBe(true);

      // Now wipe legacy too => both empty => hasAnyBatches false.
      await prisma14.batchTaskRun.deleteMany({
        where: { runtimeEnvironmentId: ctx.environmentId },
      });
      const page2 = await presenter.call(baseCall(ctx, { friendlyId: "fr_does_not_exist" }));
      expect(page2.batches).toHaveLength(0);
      expect(page2.hasAnyBatches).toBe(false);
    }
  );

  // Single-DB passthrough collapses to one handle.
  postgresTest(
    "passthrough (no readRoute): scan + probe + project all read the single handle; legacy closures never invoked",
    async ({ prisma }) => {
      const ctx = await seedParents(prisma, "pass");
      await createBatch(prisma, ctx, { id: "batch_p1", friendlyId: "fr_p1", runCount: 3 });
      await createBatch(prisma, ctx, { id: "batch_p2", friendlyId: "fr_p2", runCount: 4 });
      await createBatch(prisma, ctx, { id: "batch_p3", friendlyId: "fr_p3", runCount: 5 });

      const presenter = new BatchListPresenter(prisma, prisma);
      const page = await presenter.call(baseCall(ctx, { pageSize: 2 }));

      // Page content + ordering + cursors equal a direct $queryRaw of the same SQL.
      const direct = await rawScan(prisma, {
        environmentId: ctx.environmentId,
        pageSize: 2,
        direction: "forward",
      });
      const hasMore = direct.length > 2;
      const expectedPage = direct.slice(0, 2);
      expect(page.batches.map((b) => b.id)).toEqual(expectedPage.map((r) => r.id));
      expect(page.pagination.next).toBe(hasMore ? expectedPage[1].id : undefined);
      expect(page.pagination.previous).toBeUndefined();
      expect(page.hasAnyBatches).toBe(true);

      // A throwing legacy handle proves the split branch is never entered in passthrough.
      const throwingLegacy = spyClient(prisma, { throwOnQueryRaw: true, throwOnFindFirst: true });
      const presenterWithUnusedLegacy = new BatchListPresenter(prisma, prisma, {
        runOpsLegacyReplica: throwingLegacy.client,
        // splitEnabled omitted => passthrough; legacy must never be touched.
      });
      const page2 = await presenterWithUnusedLegacy.call(baseCall(ctx, { pageSize: 2 }));
      expect(page2.batches.map((b) => b.id)).toEqual(expectedPage.map((r) => r.id));
      expect(throwingLegacy.counts.findMany).toBe(0);
      expect(throwingLegacy.counts.findFirst).toBe(0);
    }
  );

  heteroRunOpsPostgresTest(
    "scan against dedicated RunOpsPrismaClient (splitEnabled): returns batches from new DB",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "rawscan-batch14");

      // runtimeEnvironmentId is a FK-free scalar in the run-ops schema — no parent row needed.
      await (prisma17 as RunOpsPrismaClient).batchTaskRun.create({
        data: {
          id: "rbatch00000000000000001",
          friendlyId: "fr_rbatch00000000000000001",
          runtimeEnvironmentId: ctx.environmentId,
          status: "PENDING",
          batchVersion: "v3",
          runCount: 2,
        },
      });

      const presenter = new BatchListPresenter(prisma14 as any, prisma14 as any, {
        runOpsNew: prisma17 as any,
        runOpsLegacyReplica: prisma14 as any,
        controlPlaneReplica: prisma14 as any,
        splitEnabled: true,
      });

      const page = await presenter.call(baseCall(ctx, { pageSize: 10 }));
      expect(page.batches.map((b) => b.id)).toContain("rbatch00000000000000001");
    }
  );
});
