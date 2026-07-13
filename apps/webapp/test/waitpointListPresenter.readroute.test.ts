import { describe, expect, vi } from "vitest";

// `var` (not `let`) so it is hoisted + initialized to `undefined` before the mocked
// module's getters are first read at import time (featureFlags.server reads `prisma`
// during module eval).
var dbClientHolder: any = undefined;
function setDbClient(client: any) {
  dbClientHolder = client;
}

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  return {
    Prisma,
    sqlDatabaseSchema: Prisma.sql(["public"]),
    get prisma() {
      return dbClientHolder;
    },
    get $replica() {
      return dbClientHolder;
    },
  };
});

import {
  heteroPostgresTest,
  heteroRunOpsPostgresTest,
  postgresTest,
} from "@internal/testcontainers";
import { Prisma, type PrismaClient, type WaitpointStatus } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import {
  WaitpointListPresenter,
  type WaitpointListOptions,
} from "~/presenters/v3/WaitpointListPresenter.server";

vi.setConfig({ testTimeout: 90_000 });

type SeedContext = {
  projectId: string;
  environmentId: string;
};

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
      // V2 so determineEngineVersion does not short-circuit to the V1 mismatch gate.
      engine: "V2",
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}`,
      // PRODUCTION so determineEngineVersion takes the deployment branch (an empty
      // promotion read on the real container) and falls through to project.engine = V2.
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `sc-${slug}`,
    },
  });

  return { projectId: project.id, environmentId: runtimeEnvironment.id };
}

type SeedWaitpoint = {
  id: string;
  type?: "MANUAL" | "RUN";
  status?: WaitpointStatus;
  outputIsError?: boolean;
  idempotencyKey?: string;
  inactiveIdempotencyKey?: string | null;
  userProvidedIdempotencyKey?: boolean;
  tags?: string[];
  createdAt?: Date;
};

async function seedWaitpoint(
  prisma: PrismaClient,
  ctx: SeedContext,
  wp: SeedWaitpoint
): Promise<void> {
  await prisma.waitpoint.create({
    data: {
      id: wp.id,
      friendlyId: `wp_${wp.id}`,
      type: wp.type ?? "MANUAL",
      status: wp.status ?? "PENDING",
      outputIsError: wp.outputIsError ?? false,
      idempotencyKey: wp.idempotencyKey ?? `idem-${wp.id}`,
      userProvidedIdempotencyKey: wp.userProvidedIdempotencyKey ?? false,
      inactiveIdempotencyKey: wp.inactiveIdempotencyKey ?? null,
      tags: wp.tags ?? [],
      createdAt: wp.createdAt ?? new Date(),
      projectId: ctx.projectId,
      environmentId: ctx.environmentId,
    },
  });
}

function baseOptions(
  environmentId: string,
  overrides: Partial<WaitpointListOptions> = {}
): WaitpointListOptions {
  return {
    environment: {
      id: environmentId,
      type: "PRODUCTION",
      project: { id: "irrelevant", engine: "V2" },
      apiKey: "tr_prod_test",
    },
    ...overrides,
  };
}

// The exact presenter scan SQL, run directly for the byte-identity / ORDER-BY proof.
function rawScan(
  prisma: PrismaClient,
  environmentId: string,
  direction: "forward" | "backward",
  limit: number
) {
  const schema = Prisma.sql(["public"]);
  return prisma.$queryRaw`
    SELECT
      w.id,
      w."friendlyId",
      w.status,
      w."completedAt",
      w."completedAfter",
      w."outputIsError",
      w."idempotencyKey",
      w."idempotencyKeyExpiresAt",
      w."inactiveIdempotencyKey",
      w."userProvidedIdempotencyKey",
      w."tags",
      w."createdAt"
    FROM
      ${schema}."Waitpoint" w
    WHERE
      w."environmentId" = ${environmentId}
    AND w.type = 'MANUAL'
    ORDER BY
      ${direction === "forward" ? Prisma.sql`w.id DESC` : Prisma.sql`w.id ASC`}
    LIMIT ${limit}`;
}

describe("WaitpointListPresenter read-route", () => {
  // Single-DB short-circuits to one handle (passthrough).
  postgresTest("passthrough: single handle, legacy closures never touched", async ({ prisma }) => {
    setDbClient(prisma);
    const ctx = await seedParents(prisma, "passthrough");

    await seedWaitpoint(prisma, ctx, { id: "wp00000000000000000000001", status: "PENDING" });
    await seedWaitpoint(prisma, ctx, {
      id: "wp00000000000000000000002",
      status: "COMPLETED",
      outputIsError: false,
      tags: ["b", "a"],
    });
    await seedWaitpoint(prisma, ctx, {
      id: "wp00000000000000000000003",
      status: "COMPLETED",
      outputIsError: true,
    });
    // Non-MANUAL row that must be excluded by w.type = 'MANUAL'.
    await seedWaitpoint(prisma, ctx, { id: "wp00000000000000000000099", type: "RUN" });

    // Spy: any would-be legacy handle access throws if invoked.
    const legacyThrows = new Proxy(
      {},
      {
        get() {
          throw new Error("legacy handle must never be touched in passthrough");
        },
      }
    ) as unknown as PrismaClient;

    const presenter = new WaitpointListPresenter(prisma, prisma);
    const result = await presenter.call(baseOptions(ctx.environmentId, { pageSize: 2 }));

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Page of 2, id DESC (forward).
    expect(result.tokens.map((t) => t.id)).toEqual([
      "wp_wp00000000000000000000003",
      "wp_wp00000000000000000000002",
    ]);
    expect(result.pagination.next).toBe("wp00000000000000000000002");
    expect(result.pagination.previous).toBeUndefined();
    expect(result.hasAnyTokens).toBe(true);

    // Matches a direct $queryRaw over the same SQL (excludes RUN type).
    const direct = (await rawScan(prisma, ctx.environmentId, "forward", 3)) as { id: string }[];
    expect(direct.map((r) => r.id)).toEqual([
      "wp00000000000000000000003",
      "wp00000000000000000000002",
      "wp00000000000000000000001",
    ]);

    // Constructing with a throwing legacy handle but no split must never invoke it.
    const presenterWithLegacy = new WaitpointListPresenter(prisma, prisma, {
      runOpsLegacyReplica: legacyThrows,
      // splitEnabled omitted => passthrough.
    });
    const result2 = await presenterWithLegacy.call(baseOptions(ctx.environmentId, { pageSize: 2 }));
    expect(result2.success).toBe(true);
  });

  // Raw paginated scan byte-identical + identical ORDER-BY across PG14/PG17.
  heteroPostgresTest(
    "keyset scan byte-identical + identical ORDER-BY on PG14 and PG17",
    async ({ prisma14, prisma17 }) => {
      const corpus: SeedWaitpoint[] = [
        {
          id: "wp10000000000000000000001",
          status: "PENDING",
          tags: ["alpha", "beta"],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          id: "wp10000000000000000000002",
          status: "COMPLETED",
          outputIsError: false,
          idempotencyKey: "key-2",
          userProvidedIdempotencyKey: true,
          inactiveIdempotencyKey: "old-2",
          createdAt: new Date("2024-02-01T00:00:00Z"),
        },
        {
          id: "wp10000000000000000000003",
          status: "COMPLETED",
          outputIsError: true,
          tags: ["gamma"],
          createdAt: new Date("2024-03-01T00:00:00Z"),
        },
        {
          id: "wp10000000000000000000004",
          status: "PENDING",
          createdAt: new Date("2024-04-01T00:00:00Z"),
        },
        {
          id: "wp10000000000000000000005",
          status: "COMPLETED",
          outputIsError: false,
          createdAt: new Date("2024-05-01T00:00:00Z"),
        },
        // excluded
        { id: "wp10000000000000000000099", type: "RUN" },
      ];

      // determineEngineVersion reads the module-level prisma (the holder); point it at
      // prisma14, which holds the env used by the presenter call below.
      setDbClient(prisma14);
      const ctx14 = await seedParents(prisma14, "hetero14");
      const ctx17 = await seedParents(prisma17, "hetero17");
      for (const wp of corpus) {
        await seedWaitpoint(prisma14, ctx14, wp);
        await seedWaitpoint(prisma17, ctx17, wp);
      }

      for (const direction of ["forward", "backward"] as const) {
        const rows14 = (await rawScan(prisma14, ctx14.environmentId, direction, 100)) as any[];
        const rows17 = (await rawScan(prisma17, ctx17.environmentId, direction, 100)) as any[];

        // Identical ORDER-BY sequence across versions.
        expect(rows14.map((r) => r.id)).toEqual(rows17.map((r) => r.id));
        // Byte-identical row content (id-keyed so env-id difference doesn't matter — env id is not selected).
        expect(rows14).toEqual(rows17);
        // The MANUAL filter excludes the RUN waitpoint.
        expect(rows14.some((r) => r.id === "wp10000000000000000000099")).toBe(false);
      }

      // Same with a cursor active (forward => id < cursor) — exercised via the presenter.
      const presenter14 = new WaitpointListPresenter(prisma14, prisma14);
      const cursored = await presenter14.call(
        baseOptions(ctx14.environmentId, { pageSize: 2, cursor: "wp10000000000000000000004" })
      );
      expect(cursored.success).toBe(true);
      if (cursored.success) {
        expect(cursored.tokens.map((t) => t.id)).toEqual([
          "wp_wp10000000000000000000003",
          "wp_wp10000000000000000000002",
        ]);
      }
    }
  );

  // Split scan merges migrated (new/PG17) + abandoned (legacy/PG14) tokens
  // in one keyset-ordered page; legacy READ REPLICA hit only when the new DB doesn't fill the page.
  // Structural: readRoute has no legacy-primary/writer field — only runOpsLegacyReplica.
  heteroPostgresTest(
    "split merge serves new + legacy tokens; legacy read only when new doesn't fill the page",
    async ({ prisma14, prisma17 }) => {
      // determineEngineVersion reads the module-level prisma (the holder) = the new DB.
      setDbClient(prisma17);
      // Same env id on both DBs (FK parents must exist on each side for the env-scoped WHERE).
      const ctx17 = await seedParents(prisma17, "split17");
      await seedParentsWithEnvId(prisma14, "split14", ctx17.environmentId, ctx17.projectId);

      // New (PG17): the two most-recent (highest id) MANUAL tokens. ...004 carries the
      // authoritative post-migration status (COMPLETED) and also exists on legacy as PENDING.
      await seedWaitpoint(prisma17, ctx17, { id: "wp20000000000000000000005" });
      await seedWaitpoint(prisma17, ctx17, {
        id: "wp20000000000000000000004",
        status: "COMPLETED",
        outputIsError: false,
      });
      // Legacy (PG14): older in-retention tokens (lower ids), interleaved across the keyset order,
      // plus a stale mid-migration copy of ...004 that the de-dupe must discard.
      await seedWaitpoint(prisma14, ctx17, { id: "wp20000000000000000000004", status: "PENDING" });
      await seedWaitpoint(prisma14, ctx17, { id: "wp20000000000000000000003" });
      await seedWaitpoint(prisma14, ctx17, { id: "wp20000000000000000000002" });
      await seedWaitpoint(prisma14, ctx17, { id: "wp20000000000000000000001" });

      // Wrap the legacy client to count scans (now via waitpoint.findMany after the fix).
      let legacyScanCount = 0;
      const legacyCounted = new Proxy(prisma14, {
        get(target, prop, receiver) {
          if (prop === "waitpoint") {
            const real = Reflect.get(target, prop, receiver);
            return new Proxy(real, {
              get(t, p) {
                if (p === "findMany") {
                  legacyScanCount++;
                  return t.findMany.bind(t);
                }
                return (t as any)[p];
              },
            });
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as PrismaClient;

      const presenter = new WaitpointListPresenter(prisma17, prisma17, {
        runOpsNew: prisma17,
        runOpsLegacyReplica: legacyCounted,
        splitEnabled: true,
      });

      // pageSize 4 < union of 5 => new DB (2 rows) does NOT fill page+1=5, so legacy is scanned.
      const result = await presenter.call(baseOptions(ctx17.environmentId, { pageSize: 4 }));
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Keyset-ordered union, id DESC, page of 4 (one over-fetch dropped: the oldest id).
      expect(result.tokens.map((t) => t.id)).toEqual([
        "wp_wp20000000000000000000005",
        "wp_wp20000000000000000000004",
        "wp_wp20000000000000000000003",
        "wp_wp20000000000000000000002",
      ]);
      // hasMore => next cursor is the 4th id.
      expect(result.pagination.next).toBe("wp20000000000000000000002");
      expect(legacyScanCount).toBeGreaterThan(0);

      // De-dupe: ...004 exists on both sides; it appears exactly once and the new-DB copy
      // (COMPLETED, not the legacy PENDING => WAITING) is authoritative.
      const dupes = result.tokens.filter((t) => t.id === "wp_wp20000000000000000000004");
      expect(dupes).toHaveLength(1);
      expect(dupes[0]?.status).toBe("COMPLETED");

      // Now a page the new DB fully satisfies => legacy must NOT be scanned.
      legacyScanCount = 0;
      const presenter2 = new WaitpointListPresenter(prisma17, prisma17, {
        runOpsNew: prisma17,
        runOpsLegacyReplica: legacyCounted,
        splitEnabled: true,
      });
      // pageSize 1 => page+1 = 2; new DB has 2 rows => fills the over-fetch, skip legacy.
      const result2 = await presenter2.call(baseOptions(ctx17.environmentId, { pageSize: 1 }));
      expect(result2.success).toBe(true);
      if (result2.success) {
        expect(result2.tokens.map((t) => t.id)).toEqual(["wp_wp20000000000000000000005"]);
      }
      expect(legacyScanCount).toBe(0);
    }
  );

  // Empty-state probe is dual-DB during the window (no false-empty), and reads only
  // _replica when split is off.
  heteroPostgresTest(
    "empty-state probe is dual-DB during the window",
    async ({ prisma14, prisma17 }) => {
      setDbClient(prisma17);
      const ctx = await seedParents(prisma17, "probe17");
      await seedParentsWithEnvId(prisma14, "probe14", ctx.environmentId, ctx.projectId);

      // Zero MANUAL on NEW, exactly one on LEGACY.
      await seedWaitpoint(prisma14, ctx, { id: "wp30000000000000000000001" });

      // Filter yields an empty page (no token has this idempotencyKey) so the probe runs.
      const splitPresenter = new WaitpointListPresenter(prisma17, prisma17, {
        runOpsNew: prisma17,
        runOpsLegacyReplica: prisma14,
        splitEnabled: true,
      });
      const r1 = await splitPresenter.call(
        baseOptions(ctx.environmentId, { idempotencyKey: "no-such-key" })
      );
      expect(r1.success).toBe(true);
      if (r1.success) {
        // Probe found the legacy row => not false-empty.
        expect(r1.tokens).toEqual([]);
        expect(r1.hasAnyTokens).toBe(true);
      }

      // Zero on both => empty (post-termination / past-retention normal response).
      await prisma14.waitpoint.deleteMany({ where: { environmentId: ctx.environmentId } });
      const r2 = await splitPresenter.call(
        baseOptions(ctx.environmentId, { idempotencyKey: "no-such-key" })
      );
      expect(r2.success).toBe(true);
      if (r2.success) {
        expect(r2.hasAnyTokens).toBe(false);
      }

      // split off => probe reads only _replica, never the legacy handle (throws if touched).
      const legacyThrows = new Proxy(
        {},
        {
          get() {
            throw new Error("legacy handle must never be touched when split is off");
          },
        }
      ) as unknown as PrismaClient;
      const passthroughPresenter = new WaitpointListPresenter(prisma17, prisma17, {
        runOpsLegacyReplica: legacyThrows,
      });
      const r3 = await passthroughPresenter.call(
        baseOptions(ctx.environmentId, { idempotencyKey: "no-such-key" })
      );
      expect(r3.success).toBe(true);
      if (r3.success) {
        // Nothing on the new DB and split off => empty.
        expect(r3.hasAnyTokens).toBe(false);
      }
    }
  );

  heteroRunOpsPostgresTest(
    "scan against dedicated RunOpsPrismaClient (splitEnabled): returns waitpoints from new DB",
    async ({ prisma14, prisma17 }) => {
      setDbClient(prisma14);

      const envId = "env_rawscan_wp_00000000001";
      const projId = "proj_rawscan_wp_0000000001";

      await seedParentsWithEnvId(prisma14, "rawscan-wp14", envId, projId);

      await (prisma17 as RunOpsPrismaClient).waitpoint.create({
        data: {
          id: "rwp0000000000000000000001",
          friendlyId: "wp_rwp0000000000000000000001",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: "idem-rawscan-wp-1",
          userProvidedIdempotencyKey: false,
          outputIsError: false,
          tags: [],
          projectId: projId,
          environmentId: envId,
        },
      });

      const presenter = new WaitpointListPresenter(prisma14 as any, prisma14 as any, {
        runOpsNew: prisma17 as any,
        runOpsLegacyReplica: prisma14 as any,
        splitEnabled: true,
      });

      const result = await presenter.call({
        environment: {
          id: envId,
          type: "PRODUCTION",
          project: { id: projId, engine: "V2" },
          apiKey: "tr_prod_rawscan",
        },
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.tokens.map((t) => t.id)).toContain("wp_rwp0000000000000000000001");
    }
  );
});

// Seed org/project/env reusing a caller-supplied env+project id (so the same env id exists on a
// second DB for the cross-DB union/probe cases).
async function seedParentsWithEnvId(
  prisma: PrismaClient,
  slug: string,
  environmentId: string,
  projectId: string
): Promise<void> {
  const organization = await prisma.organization.create({
    data: { title: `org-${slug}`, slug: `org-${slug}` },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: organization.id,
      externalRef: `proj-${slug}`,
      engine: "V2",
    },
  });
  await prisma.runtimeEnvironment.create({
    data: {
      id: environmentId,
      slug: `env-${slug}`,
      type: "PRODUCTION",
      projectId,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `sc-${slug}`,
    },
  });
}
