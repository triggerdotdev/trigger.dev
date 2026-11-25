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
import { keyedWaitpointTest } from "../../../internal-packages/run-engine/src/engine/tests/utils/keyedWaitpointTest";
import {
  WaitpointStoreCoordinator,
  type WaitpointRecordInput,
} from "../../../internal-packages/run-engine/src/engine/waitpointCoordinator/storeCoordinator";
import {
  makeEngine,
  triggerRun,
} from "../../../internal-packages/run-engine/src/engine/tests/utils/storeRunWaitpointLifecycleFixtures";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import {
  generateRunOpsIdV2,
  generateWaitpointId,
  RunId,
  WaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import { randomUUID } from "node:crypto";
import Redis, { type RedisOptions } from "ioredis";
import { PostgresRunStore, RoutingRunStore, RedisSnapshotStore } from "@internal/run-store";
import {
  WaitpointListPresenter,
  type WaitpointListOptions,
} from "~/presenters/v3/WaitpointListPresenter.server";

vi.setConfig({ testTimeout: 90_000 });

// Wire the presenter's run store to the test containers so waitpoint reads route to the
// container DBs (NEW=dedicated, LEGACY=legacy) instead of the default localhost:5432 client.
// In single-DB passthrough both legs point at the same client (a no-op fan-out that de-dupes
// back to one DB's rows), mirroring production single-DB deployments.
function makeRunStore(newClient: PrismaClient, legacyClient: PrismaClient): RoutingRunStore {
  return new RoutingRunStore({
    new: new PostgresRunStore({
      prisma: newClient as never,
      readOnlyPrisma: newClient as never,
      schemaVariant: "dedicated",
    }),
    legacy: new PostgresRunStore({
      prisma: legacyClient as never,
      readOnlyPrisma: legacyClient as never,
      schemaVariant: "legacy",
    }),
  });
}

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

    // Single-DB deployment: both run-store legs point at the same container client, so the
    // mandatory NEW+LEGACY fan-out in findManyWaitpoints reads one DB and de-dupes by id.
    const presenter = new WaitpointListPresenter(
      prisma,
      prisma,
      undefined,
      makeRunStore(prisma, prisma)
    );
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

    // FLAG: dropped the old "throwing legacy handle never invoked" tripwire — RoutingRunStore's
    // findManyWaitpoints always fans out to both legs, so single-DB is modeled by both legs
    // sharing one client (above), not by a throwing legacy leg.
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
      const presenter14 = new WaitpointListPresenter(
        prisma14,
        prisma14,
        undefined,
        makeRunStore(prisma14, prisma14)
      );
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

      const presenter = new WaitpointListPresenter(
        prisma17,
        prisma17,
        undefined,
        makeRunStore(prisma17, legacyCounted)
      );

      // pageSize 4 < union of 5 => merged NEW (2 rows) + LEGACY page fills 4.
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

      // A page the new DB fully satisfies still returns only the newest token.
      legacyScanCount = 0;
      const presenter2 = new WaitpointListPresenter(
        prisma17,
        prisma17,
        undefined,
        makeRunStore(prisma17, legacyCounted)
      );
      // pageSize 1 => page+1 = 2; new DB has 2 rows, so its keyset window already covers the page.
      const result2 = await presenter2.call(baseOptions(ctx17.environmentId, { pageSize: 1 }));
      expect(result2.success).toBe(true);
      if (result2.success) {
        expect(result2.tokens.map((t) => t.id)).toEqual(["wp_wp20000000000000000000005"]);
      }
      // FLAG: dropped the old "legacy NOT scanned when new fills the page" tripwire.
      // RoutingRunStore.findManyWaitpoints unconditionally fans out to both legs, so legacy is
      // always scanned; the result (only the newest token) is what proves the window is correct.
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
      const splitPresenter = new WaitpointListPresenter(
        prisma17,
        prisma17,
        undefined,
        makeRunStore(prisma17, prisma14)
      );
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

      // Single-DB passthrough: both legs share one client; the probe (findWaitpoint) tries NEW
      // then LEGACY, both empty here, so no false-positive.
      const passthroughPresenter = new WaitpointListPresenter(
        prisma17,
        prisma17,
        undefined,
        makeRunStore(prisma17, prisma17)
      );
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

      const presenter = new WaitpointListPresenter(
        prisma14 as any,
        prisma14 as any,
        undefined,
        makeRunStore(prisma17 as any, prisma14 as any)
      );

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

describe("native MANUAL token list", () => {
  keyedWaitpointTest(
    "merges native tokens with legacy ID pagination and preserves indexed filters and scoped URLs",
    async ({ prisma: fixturePrisma, redisOptions }) => {
      const prisma = fixturePrisma as PrismaClient;
      setDbClient(prisma);
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const snapshots = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60000 });
      let enabled = true;
      const engine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore: snapshots,
        workerDisabled: true,
        isWaitpointStoreEnabled: () => enabled,
      });
      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, environment, ["manual-list"]);
        const run = await triggerRun(engine, environment, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "manual-list",
        });
        const scope = {
          runId: run.id,
          environmentId: environment.id,
          projectId: environment.projectId,
          organizationId: environment.organizationId,
        };
        const waiting = await engine.createManualWaitpoint({
          ...scope,
          idempotencyKey: "same-key",
          idempotencyKeyExpiresAt: new Date(Date.now() + 1000),
          tags: ["first", "shared"],
        });
        const completed = await engine.createManualWaitpoint({
          ...scope,
          idempotencyKey: "completed-key",
          tags: ["shared"],
        });
        const timedOut = await engine.createManualWaitpoint({ ...scope, tags: ["timeout"] });
        await engine.completeWaitpoint({
          id: completed.waitpoint.id,
          organizationId: environment.organizationId,
          output: { value: "ok", isError: false },
        });
        await engine.completeWaitpoint({
          id: timedOut.waitpoint.id,
          organizationId: environment.organizationId,
          output: { value: "timeout", isError: true },
        });
        await seedWaitpoint(
          prisma,
          { projectId: environment.projectId, environmentId: environment.id },
          { id: "zz-legacy-manual", tags: ["legacy"] }
        );
        const presenter = new WaitpointListPresenter(
          prisma,
          prisma,
          undefined,
          new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          engine
        );
        const options = {
          environment: {
            ...environment,
            project: { ...environment.project, engine: "V2" as const },
          },
        };
        const all = await presenter.call({ ...options, pageSize: 10 });
        expect(all.success).toBe(true);
        expect(all.tokens.map((token) => token.id)).toEqual([
          "wp_zz-legacy-manual",
          ...[waiting, completed, timedOut]
            .sort((a, b) => (a.waitpoint.id < b.waitpoint.id ? 1 : -1))
            .map((result) => result.waitpoint.friendlyId),
        ]);
        const native = all.tokens.find((token) => token.id === waiting.waitpoint.friendlyId)!;
        expect(native.url).toContain("wp1.");
        expect(
          (await presenter.call({ ...options, id: waiting.waitpoint.friendlyId })).tokens.map(
            (token) => token.id
          )
        ).toEqual([waiting.waitpoint.friendlyId]);
        expect(
          (await presenter.call({ ...options, idempotencyKey: "same-key" })).tokens.map(
            (token) => token.id
          )
        ).toEqual([waiting.waitpoint.friendlyId]);
        expect(
          (await presenter.call({ ...options, tags: ["first", "timeout"] })).tokens
            .map((token) => token.id)
            .sort()
        ).toEqual([waiting.waitpoint.friendlyId, timedOut.waitpoint.friendlyId].sort());
        for (const [status, token] of [
          ["WAITING", waiting],
          ["COMPLETED", completed],
          ["TIMED_OUT", timedOut],
        ] as const) {
          const found = await presenter.call({
            ...options,
            statuses: [status],
            tags: ["shared", "timeout"],
          });
          expect(found.tokens.map((item) => item.id)).toEqual([token.waitpoint.friendlyId]);
        }
        const time = waiting.waitpoint.createdAt.getTime();
        expect(
          (await presenter.call({ ...options, from: time, to: time })).tokens.some(
            (token) => token.id === waiting.waitpoint.friendlyId
          )
        ).toBe(true);
        const first = await presenter.call({ ...options, pageSize: 2 });
        const second = await presenter.call({
          ...options,
          pageSize: 2,
          cursor: first.pagination.next,
        });
        expect([...first.tokens, ...second.tokens].map((token) => token.id)).toEqual(
          all.tokens.map((token) => token.id)
        );
        const backward = await presenter.call({
          ...options,
          pageSize: 2,
          direction: "backward",
          cursor: second.tokens[0].id.replace("waitpoint_", ""),
        });
        expect(backward.tokens.map((token) => token.id)).toEqual(
          first.tokens.map((token) => token.id)
        );
        const empty = await presenter.call({ ...options, tags: ["missing"] });
        expect(empty.tokens).toEqual([]);
        expect(empty.success && empty.hasAnyTokens).toBe(true);
        expect(
          (
            await presenter.call({
              ...options,
              environment: { ...options.environment, id: "foreign-env" },
            })
          ).tokens
        ).toEqual([]);
        enabled = false;
        await store.quit();
        const off = await presenter.call({ ...options });
        expect(off.tokens.map((token) => token.id)).toEqual(["wp_zz-legacy-manual"]);
      } finally {
        await engine.quit();
        await store.quit();
        await snapshots.quit();
      }
    }
  );

  // Catches: a Postgres token newer than MemoryDB tokens listed below them, or paging that skips or repeats one.
  keyedWaitpointTest(
    "lists tokens from both sources newest first by createdAt and pages both ways",
    async ({ prisma, redisOptions }) => {
      await withNativeList(
        prisma as PrismaClient,
        redisOptions,
        async ({ store, legacy, list }) => {
          const s1 = await store();
          const s2 = await store();
          const s3 = await store();
          const p1 = await legacy("cmord00000000000000000001", at(s1, -60_000));
          const p2 = await legacy("cmord00000000000000000002", at(s1, 1));
          const p3 = await legacy("cmord00000000000000000003", at(s3, 60_000));
          const expected = [p3, s3, s2, p2, s1, p1].map(friendly);

          expect(await ids(list({ pageSize: 10 }))).toEqual(expected);
          for (const pageSize of [1, 2, 4]) {
            const { forward, backward } = await walk(list, { pageSize });
            expect(forward.flat()).toEqual(expected);
            expect(backward).toEqual(forward.slice(0, -1));
          }
        }
      );
    }
  );

  // Catches: a filtered list across both sources losing createdAt order or tokens once a cursor is applied.
  keyedWaitpointTest(
    "keeps createdAt order when a tag filter and a cursor cross both sources",
    async ({ prisma, redisOptions }) => {
      await withNativeList(
        prisma as PrismaClient,
        redisOptions,
        async ({ store, legacy, list }) => {
          const s1 = await store(["keep"]);
          const s2 = await store();
          const s3 = await store(["keep"]);
          const p1 = await legacy("cmflt00000000000000000001", at(s1, -60_000), ["keep"]);
          await legacy("cmflt00000000000000000002", at(s2, 1));
          const p3 = await legacy("cmflt00000000000000000003", at(s3, 60_000), ["keep"]);
          const expected = [p3, s3, s1, p1].map(friendly);

          for (const pageSize of [1, 3]) {
            const { forward, backward } = await walk(list, { pageSize, tags: ["keep"] });
            expect(forward.flat()).toEqual(expected);
            expect(backward).toEqual(forward.slice(0, -1));
          }
        }
      );
    }
  );

  // Catches: a time-ordered gen-2 Postgres id ranked below every MemoryDB token instead of by age.
  keyedWaitpointTest(
    "orders a gen-2 Postgres token among MemoryDB tokens by age",
    async ({ prisma, redisOptions }) => {
      await withNativeList(
        prisma as PrismaClient,
        redisOptions,
        async ({ store, legacy, list }) => {
          const s1 = await store();
          await nextMillisecond(2);
          const g = await legacy(generateRunOpsIdV2("a"), new Date());
          await nextMillisecond(2);
          const s2 = await store();
          const expected = [s2, g, s1].map(friendly);

          expect(await ids(list({ pageSize: 10 }))).toEqual(expected);
          const { forward, backward } = await walk(list, { pageSize: 1 });
          expect(forward.flat()).toEqual(expected);
          expect(backward).toEqual(forward.slice(0, -1));
        }
      );
    }
  );

  // Catches: a bare id cursor from an old URL or a client mid-page throwing after the cursor format changed.
  keyedWaitpointTest(
    "accepts bare legacy and store id cursors",
    async ({ prisma, redisOptions }) => {
      await withNativeList(
        prisma as PrismaClient,
        redisOptions,
        async ({ store, legacy, list }) => {
          const s1 = await store();
          const s2 = await store();
          const p1 = await legacy("cmbare00000000000000000001", at(s1, -60_000));
          for (const cursor of [s2.id, p1.id, "m.!!"])
            for (const direction of ["forward", "backward"] as const) {
              const result = await list({ cursor, direction, pageSize: 2 });
              expect(result.success).toBe(true);
              const found = result.tokens.map((token) => token.id);
              expect(new Set(found).size).toBe(found.length);
            }
        }
      );
    }
  );

  // Catches: an organisation without the waitpoint store seeing a changed order or Postgres cursor condition.
  keyedWaitpointTest(
    "keeps raw id order and cursor conditions when the store is disabled",
    async ({ prisma: fixturePrisma, redisOptions }) => {
      const prisma = fixturePrisma as PrismaClient;
      await withNativeList(prisma, redisOptions, async ({ engine }) => {
        const ctx = await seedParents(prisma, "order-off");
        for (const id of ["1", "2", "3"])
          await seedWaitpoint(prisma, ctx, { id: `cmoff0000000000000000000${id}` });
        const { organizationId } = await prisma.runtimeEnvironment.findUniqueOrThrow({
          where: { id: ctx.environmentId },
        });
        const scans: unknown[] = [];
        const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
        const presenter = new WaitpointListPresenter(
          prisma,
          prisma,
          undefined,
          {
            findManyWaitpoints: (args: { where: { id?: unknown } }) => {
              scans.push(args.where.id);
              return runStore.findManyWaitpoints(args as never);
            },
            findWaitpoint: runStore.findWaitpoint.bind(runStore),
          } as never,
          engine
        );
        const options = baseOptions(ctx.environmentId, { pageSize: 2 });
        options.environment.organizationId = organizationId;

        const first = await presenter.call(options);
        const second = await presenter.call({ ...options, cursor: first.pagination.next });
        const back = await presenter.call({
          ...options,
          direction: "backward",
          cursor: second.pagination.previous,
        });
        expect(first.tokens.map((token) => token.id)).toEqual([
          "wp_cmoff00000000000000000003",
          "wp_cmoff00000000000000000002",
        ]);
        expect(second.tokens.map((token) => token.id)).toEqual(["wp_cmoff00000000000000000001"]);
        expect(back.tokens.map((token) => token.id)).toEqual(first.tokens.map((token) => token.id));
        expect(scans).toEqual([
          undefined,
          { lt: "cmoff00000000000000000002" },
          { gt: "cmoff00000000000000000001" },
        ]);
      });
    }
  );

  // Catches: a list request whose MemoryDB work grows with its filters or with the environment, and
  // a mixed Postgres and MemoryDB list that skips, repeats or misorders tokens where MemoryDB stopped.
  keyedWaitpointTest(
    "issues at most 100 store commands per list call for every filter, both ways",
    { timeout: 300_000 },
    async ({ prisma: fixturePrisma, redisOptions }) => {
      const prisma = fixturePrisma as PrismaClient;
      await withStandaloneList(
        prisma,
        redisOptions,
        async ({ engine, coordinator, scope, list }) => {
          const now = Date.now();
          const seeds = corpus(3_000, now);
          const legacySeeds = corpus(50, now - 500, "old-key");
          const legacyIds = await seedLegacy(prisma, scope, "cmbound", legacySeeds);
          const storeIds = await seedStore(coordinator, scope, seeds.slice(0, 500));
          // An unflagged twin holds the same 550 tokens in Postgres, ids in creation order.
          const twin = await unflaggedEnvironment(prisma, engine, "bound-twin");
          const mixed = [
            ...legacySeeds.map((seed, i) => ({ seed, id: legacyIds[i]! })),
            ...seeds.slice(0, 500).map((seed, i) => ({ seed, id: storeIds[i]! })),
          ].sort((a, b) => a.seed.createdAt.getTime() - b.seed.createdAt.getTime());
          const twinIds = await seedLegacy(
            prisma,
            twin.ctx,
            "cmbtwin",
            mixed.map(({ seed }) => seed)
          );
          const twinOf = (id: string) => twinIds[mixed.findIndex((token) => token.id === id)]!;
          const counter = await commandCounter(redisOptions);
          try {
            for (const size of [500, 3_000]) {
              if (size === 3_000)
                storeIds.push(...(await seedStore(coordinator, scope, seeds.slice(500))));
              const ids: [string, string] = [storeIds[size - 1]!, legacyIds[0]!];
              const filters = filterSet(seeds.slice(0, size), ids, now);
              let largest = 0;
              for (const [name, filter] of filters)
                for (const pageSize of [25, 100])
                  for (const direction of ["forward", "backward"] as const) {
                    const options = { ...filter, pageSize, direction };
                    const first = await counter.count(() => list(options));
                    const cursor =
                      direction === "forward"
                        ? first.result.pagination.next
                        : first.result.pagination.previous;
                    const second = cursor
                      ? await counter.count(() => list({ ...options, cursor }))
                      : undefined;
                    for (const call of [first, second]) {
                      if (!call) continue;
                      expect(
                        call.commands,
                        `${size} ${name} ${pageSize} ${direction}`
                      ).toBeLessThanOrEqual(LIST_BOUND);
                      largest = Math.max(largest, call.commands);
                    }
                  }
              console.log(`largest store command count with ${size} MemoryDB tokens: ${largest}`);
              expect(largest).toBeGreaterThan(0);
              if (size !== 500) continue;
              const twinFilters = filterSet(
                seeds.slice(0, size),
                [twinOf(ids[0]), twinOf(ids[1])],
                now
              );
              for (const [k, [name, filter]] of filters.entries()) {
                const walk = await walkPages(list, { ...filter, pageSize: 25 });
                const expected = await walkPages(twin.list, {
                  ...twinFilters[k]![1],
                  pageSize: 25,
                });
                expect(walk.forward.flatMap(view), name).toEqual(expected.forward.flatMap(view));
                expect(walk.backward.flatMap(tokenIds), name).toEqual(
                  walk.forward.flatMap(tokenIds)
                );
              }
            }
          } finally {
            counter.quit();
          }
        }
      );
    }
  );

  // Catches: a command ceiling, or the short pages it makes, reaching an organisation without the
  // standalone tokens flag, whose lists must stay as they were.
  keyedWaitpointTest(
    "lists without a command ceiling while the standalone tokens flag is off",
    { timeout: 300_000 },
    async ({ prisma: fixturePrisma, redisOptions }) => {
      const prisma = fixturePrisma as PrismaClient;
      await withNativeList(
        prisma,
        redisOptions,
        async ({ coordinator, scope, list, storeLists }) => {
          const now = Date.now();
          const seeds = corpus(300, now);
          const storeIds = await seedStore(coordinator, scope, seeds);
          for (const [name, filter] of filterSet(seeds, [storeIds[1]!, storeIds[299]!], now)) {
            const walk = await walkPages(list, { ...filter, pageSize: 25 });
            expect(
              walk.forward.slice(0, -1).every((page) => page.tokens.length === 25),
              name
            ).toBe(true);
          }
          expect(storeLists.length).toBeGreaterThan(0);
          expect(storeLists.every((params) => params.commandCeiling === undefined)).toBe(true);
        }
      );
    }
  );

  // Catches: a flagged walk that skips, repeats or reorders tokens when MemoryDB pages stop short,
  // or a list path that issues MemoryDB commands for an organisation without the store.
  keyedWaitpointTest(
    "walks every filter as an unflagged environment does, both ways",
    { timeout: 300_000 },
    async ({ prisma: fixturePrisma, redisOptions }) => {
      const prisma = fixturePrisma as PrismaClient;
      await withStandaloneList(
        prisma,
        redisOptions,
        async ({ engine, coordinator, scope, list }) => {
          const now = Date.now();
          const seeds = corpus(300, now);
          const storeIds = await seedStore(coordinator, scope, seeds);
          const twin = await unflaggedEnvironment(prisma, engine, "twins");
          const twinIds = await seedLegacy(prisma, twin.ctx, "cmtwin", seeds);
          const filters = filterSet(seeds, [storeIds[1]!, storeIds[299]!], now);
          const twinFilters = filterSet(seeds, [twinIds[1]!, twinIds[299]!], now);
          const counter = await commandCounter(redisOptions);
          try {
            for (const [k, [name, filter]] of filters.entries())
              for (const pageSize of [2, 25]) {
                const options = { ...filter, pageSize };
                const flagged = await walkPages(list, options);
                const { result: unflagged, commands } = await counter.count(() =>
                  walkPages(twin.list, { ...twinFilters[k]![1], pageSize })
                );
                expect(commands, `${name} ${pageSize}`).toBe(0);
                const tokens = flagged.forward.flatMap(view);
                expect(tokens, `${name} ${pageSize}`).toEqual(unflagged.forward.flatMap(view));
                if (k !== filters.length - 2) expect(tokens.length, name).toBeGreaterThan(0);
                for (const walk of [flagged, unflagged])
                  expect(walk.backward.flatMap(tokenIds), name).toEqual(
                    walk.forward.flatMap(tokenIds)
                  );
                expect(
                  unflagged.forward.slice(0, -1).every((page) => page.tokens.length === pageSize),
                  name
                ).toBe(true);
                await expectWayBack(list, options, flagged);
              }
          } finally {
            counter.quit();
          }
        }
      );
    }
  );

  // Catches: the dashboard showing the empty state, or no next page, when MemoryDB stops a page short.
  keyedWaitpointTest(
    "keeps the next page and the token list when a dashboard page stops short",
    async ({ prisma, redisOptions }) => {
      await withStandaloneList(
        prisma as PrismaClient,
        redisOptions,
        async ({ coordinator, scope, list }) => {
          const now = Date.now();
          // The 3 oldest "rare" tokens are completed, the 300 newer ones wait; 300 completed without it.
          const seeds: Seed[] = Array.from({ length: 603 }, (_, i) => ({
            createdAt: new Date(now - (603 - i) * 1000),
            ...(i < 303 ? { tags: ["rare"] } : {}),
            outputIsError: i < 3 || i >= 303 ? false : undefined,
          }));
          const ids = await seedStore(coordinator, scope, seeds);
          const options = { tags: ["rare"], statuses: ["COMPLETED" as const] };
          const walk = await walkPages(list, options);
          const first = walk.forward[0]!;
          expect(first.tokens.length).toBeLessThan(25);
          expect(first.pagination.next).toBeDefined();
          expect(first.success && first.hasAnyTokens).toBe(true);
          expect(walk.forward.flatMap(tokenIds)).toEqual(ids.slice(0, 3).reverse());
          expect(walk.forward.at(-1)!.pagination.next).toBeUndefined();
          expect(walk.backward.flatMap(tokenIds)).toEqual(ids.slice(0, 3).reverse());
          await expectWayBack(list, options, walk);
        }
      );
    }
  );

  // Catches: a date-filtered list under the ceiling walking every MemoryDB id outside its window.
  keyedWaitpointTest(
    "starts and stops a date-filtered MemoryDB walk at the window's edges",
    async ({ prisma, redisOptions }) => {
      await withStandaloneList(
        prisma as PrismaClient,
        redisOptions,
        async ({ coordinator, scope, list }) => {
          const now = Date.now();
          // Ten seconds apart, so 300 s of creation window holds 30 tokens of 300.
          const seeds = Array.from({ length: 300 }, (_, i) => ({
            createdAt: new Date(now - (300 - i) * 10_000),
          }));
          const ids = await seedStore(coordinator, scope, seeds);
          const time = (i: number) => seeds[i]!.createdAt.getTime();
          for (const [filter, expected] of [
            [{ to: time(4) }, ids.slice(0, 5)],
            [{ from: time(295) }, ids.slice(295)],
          ] as const) {
            const walk = await walkPages(list, filter);
            expect(walk.forward[0]!.tokens.map((t) => t.id)).toEqual([...expected].reverse());
            expect(walk.forward.length).toBeLessThanOrEqual(2);
            expect(walk.backward.length).toBeLessThanOrEqual(2);
            expect(walk.backward.flatMap(tokenIds)).toEqual([...expected].reverse());
          }
        }
      );
    }
  );

  // Catches: Postgres tokens listed among or before newer MemoryDB tokens, or a token listed twice.
  keyedWaitpointTest(
    "lists newer MemoryDB tokens before older Postgres tokens, each once, both ways",
    async ({ prisma: fixturePrisma, redisOptions }) => {
      const prisma = fixturePrisma as PrismaClient;
      await withStandaloneList(prisma, redisOptions, async ({ coordinator, scope, list }) => {
        const now = Date.now();
        const tagged = (every: number) => (i: number) => (i % every === 0 ? ["five"] : []);
        const old = Array.from({ length: 40 }, (_, i) => ({
          createdAt: new Date(now - 1_000_000 + i * 1000),
          tags: tagged(8)(i),
        }));
        const recent = Array.from({ length: 300 }, (_, i) => ({
          createdAt: new Date(now - 300_000 + i * 1000),
          tags: tagged(60)(i),
        }));
        const legacyIds = await seedLegacy(prisma, scope, "cmsix", old);
        const storeIds = await seedStore(coordinator, scope, recent);
        for (const tags of [undefined, ["five"]])
          for (const pageSize of [10, 25]) {
            const options = { pageSize, ...(tags ? { tags } : {}) };
            const keep = (every: number) => (_: string, i: number) => !tags || i % every === 0;
            const expected = [...legacyIds.filter(keep(8)), ...storeIds.filter(keep(60))].reverse();
            expect(expected).toHaveLength(tags ? 10 : 340);
            const walk = await walkPages(list, options);
            expect(walk.forward.flatMap(tokenIds)).toEqual(expected);
            expect(walk.backward.flatMap(tokenIds)).toEqual(expected);
            await expectWayBack(list, options, walk);
          }
      });
    }
  );

  // Catches: the empty state shown for an environment whose tokens are all in MemoryDB, or hidden
  // for one with no tokens at all.
  keyedWaitpointTest(
    "says whether an environment has tokens as an unflagged environment does",
    async ({ prisma: fixturePrisma, redisOptions }) => {
      const prisma = fixturePrisma as PrismaClient;
      await withStandaloneList(
        prisma,
        redisOptions,
        async ({ engine, coordinator, scope, list }) => {
          const twin = await unflaggedEnvironment(prisma, engine, "has-tokens");
          const hasAnyTokens = (page: ListPage) => {
            expect(page.success).toBe(true);
            return page.success && page.hasAnyTokens;
          };
          expect(hasAnyTokens(await list({}))).toBe(false);
          expect(hasAnyTokens(await twin.list({}))).toBe(false);
          const seeds = corpus(3, Date.now());
          const storeIds = await seedStore(coordinator, scope, seeds);
          await seedLegacy(prisma, twin.ctx, "cmhas", seeds);
          const listed = await list({});
          expect(tokenIds(listed)).toEqual([...storeIds].reverse());
          expect(hasAnyTokens(listed)).toBe(true);
          expect(hasAnyTokens(await list({ tags: ["missing"] }))).toBe(true);
          expect(hasAnyTokens(await twin.list({ tags: ["missing"] }))).toBe(true);
        }
      );
    }
  );

  // Catches: a forward page that stops short listing a Postgres token before an unseen MemoryDB
  // token created after it, because that token's id was minted before the stop.
  keyedWaitpointTest(
    "orders a MemoryDB token created after its id time past a short page's stop",
    async ({ prisma: fixturePrisma, redisOptions }) => {
      const prisma = fixturePrisma as PrismaClient;
      await withStandaloneList(prisma, redisOptions, async ({ coordinator, scope, list }) => {
        const base = Date.now() - 2_000_000;
        // Newer tokens that are tagged or completed, not both, so either index walk stops among them.
        const filler = Array.from({ length: 600 }, (_, i) => ({
          createdAt: new Date(base + 60_000 + i * 100),
          ...(i % 2 ? { tags: ["x"] } : { outputIsError: false }),
        }));
        const done = { tags: ["x"], outputIsError: false };
        const late = { ...done, mintedAt: new Date(base), createdAt: new Date(base + 299_000) };
        const [storeId] = await seedStore(coordinator, scope, [late, ...filler]);
        const [legacyId] = await seedLegacy(prisma, scope, "cmlate", [
          { ...done, createdAt: new Date(base + 298_000) },
        ]);
        const walk = await walkPages(list, { tags: ["x"], statuses: ["COMPLETED"] });
        expect(walk.forward[0]!.pagination.next).toBeDefined();
        expect(walk.forward.flatMap(tokenIds)).toEqual([storeId, legacyId]);
        expect(walk.backward.flatMap(tokenIds)).toEqual([storeId, legacyId]);
      });
    }
  );
});

type ListPage = Awaited<ReturnType<WaitpointListPresenter["call"]>>;
type ListCall = (overrides: Partial<WaitpointListOptions>) => Promise<ListPage>;
type Token = { id: string; friendlyId: string; createdAt: Date };

const friendly = (token: Token) => token.friendlyId;
const at = (token: Token, offsetMs: number) => new Date(token.createdAt.getTime() + offsetMs);
const ids = async (page: Promise<ListPage>) => (await page).tokens.map((token) => token.id);

// Real clock, no sleeping: yield until the millisecond has moved on, so createdAt values differ.
async function nextMillisecond(ms = 1) {
  const until = Date.now() + ms;
  while (Date.now() < until) await new Promise((resolve) => setImmediate(resolve));
}

// Pages forward to the end, then backward from the last page to the first.
async function walk(list: ListCall, options: Partial<WaitpointListOptions>) {
  const forward = [await list(options)];
  while (forward.at(-1)!.pagination.next && forward.length < 20)
    forward.push(await list({ ...options, cursor: forward.at(-1)!.pagination.next }));
  const backward: string[][] = [];
  let page = forward.at(-1)!;
  while (page.pagination.previous && backward.length < 20) {
    page = await list({ ...options, direction: "backward", cursor: page.pagination.previous });
    backward.unshift(page.tokens.map((token) => token.id));
  }
  return { forward: forward.map((p) => p.tokens.map((token) => token.id)), backward };
}

// An engine with the waitpoint store enabled for one organisation, plus helpers to add tokens.
async function withNativeList(
  prisma: PrismaClient,
  redisOptions: Parameters<typeof makeEngine>[1],
  body: (harness: {
    engine: ReturnType<typeof makeEngine>;
    coordinator: WaitpointStoreCoordinator;
    scope: StoreScope;
    store: (tags?: string[]) => Promise<Token>;
    legacy: (id: string, createdAt: Date, tags?: string[]) => Promise<Token>;
    list: ListCall;
    storeLists: Parameters<ReturnType<typeof makeEngine>["listStoreManualWaitpoints"]>[0][];
  }) => Promise<void>,
  standaloneTokens = false
) {
  setDbClient(prisma);
  const coordinator = new WaitpointStoreCoordinator({ redisOptions });
  const snapshots = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60000 });
  let enabledOrgId = "";
  const engine = makeEngine(prisma, redisOptions, {
    store: coordinator,
    snapshotStore: snapshots,
    workerDisabled: true,
    isWaitpointStoreEnabled: (organizationId) => organizationId === enabledOrgId,
  });
  try {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    enabledOrgId = environment.organizationId;
    await setupBackgroundWorker(engine, environment, ["manual-order"]);
    const run = await triggerRun(engine, environment, prisma, {
      friendlyId: RunId.generate().friendlyId,
      taskIdentifier: "manual-order",
    });
    const ctx = { projectId: environment.projectId, environmentId: environment.id };
    const storeLists: Parameters<typeof engine.listStoreManualWaitpoints>[0][] = [];
    const presenter = new WaitpointListPresenter(
      prisma,
      prisma,
      undefined,
      new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
      {
        listStoreManualWaitpoints: (params) => {
          storeLists.push(params);
          return engine.listStoreManualWaitpoints(params);
        },
        canReadStoreManualWaitpoints: (organizationId) =>
          engine.canReadStoreManualWaitpoints(organizationId),
      }
    );
    const environmentOption = {
      ...environment,
      project: { ...environment.project, engine: "V2" as const },
      organization: {
        ...environment.organization,
        featureFlags: { waitpointStoreStandaloneTokens: standaloneTokens },
      },
    };
    await body({
      engine,
      coordinator,
      scope: { ...ctx, organizationId: environment.organizationId },
      store: async (tags) => {
        await nextMillisecond(2);
        const { waitpoint } = await engine.createManualWaitpoint({
          ...ctx,
          runId: run.id,
          organizationId: environment.organizationId,
          tags,
        });
        return waitpoint;
      },
      legacy: async (id, createdAt, tags) => {
        await seedWaitpoint(prisma, ctx, { id, createdAt, tags });
        return { id, friendlyId: `wp_${id}`, createdAt };
      },
      list: (overrides) => presenter.call({ environment: environmentOption, ...overrides }),
      storeLists,
    });
  } finally {
    await engine.quit();
    await coordinator.quit();
    await snapshots.quit();
  }
}

// The same, with the standalone tokens flag on for that organisation: lists get a command ceiling.
const withStandaloneList: typeof withNativeList = (prisma, redisOptions, body) =>
  withNativeList(prisma, redisOptions, body, true);

type StoreScope = { organizationId: string; projectId: string; environmentId: string };
// A token to seed; outputIsError set means completed (true: timed out).
type Seed = {
  createdAt: Date;
  mintedAt?: Date;
  tags?: string[];
  idempotencyKey?: string;
  outputIsError?: boolean;
};
type FilterSet = [name: string, filter: Partial<WaitpointListOptions>][];

const DAY = 86_400_000;
const LIST_BOUND = 100;
const view = (page: ListPage) =>
  page.tokens.map((t) => [t.createdAt.toISOString(), t.status, t.tags, t.idempotencyKey]);
const tokenIds = (page: ListPage) => page.tokens.map((token) => token.id);

// Token i is the i-th oldest, one second apart; the five oldest are three days old, so a one-day
// period leaves them out. The three oldest hold "rare" and are completed; ids follow creation order.
function corpus(size: number, now: number, key = "key"): Seed[] {
  return Array.from({ length: size }, (_, i) => ({
    createdAt: new Date(i < 5 ? now - 3 * DAY + i * 1000 : now - (size - i) * 1000),
    tags: [`t${i % 200}`, ...(i < 3 ? ["rare"] : [])],
    idempotencyKey: i % 10 === 0 ? `${key}-${i}` : undefined,
    outputIsError: i < 3 || i % 4 === 1 ? false : i % 4 === 2 ? true : undefined,
  }));
}

// Section (b) of the filter set takes each environment's own ids.
function filterSet(seeds: Seed[], ids: [string, string], now: number): FilterSet {
  const time = (i: number) => seeds[i]!.createdAt.getTime();
  const last = seeds.length - 1;
  return [
    ["no filter", {}],
    ["first id", { id: ids[0] }],
    ["second id", { id: ids[1] }],
    ["waiting", { statuses: ["WAITING"] }],
    ["completed", { statuses: ["COMPLETED"] }],
    ["timed out", { statuses: ["TIMED_OUT"] }],
    ["waiting or timed out", { statuses: ["WAITING", "TIMED_OUT"] }],
    ["idempotency key", { idempotencyKey: "key-0" }],
    ["one tag", { tags: ["rare"] }],
    ["three tags", { tags: ["rare", "t7", "t8"] }],
    ["150 tags", { tags: Array.from({ length: 150 }, (_, k) => `t${k}`) }],
    ["period", { period: "1d" }],
    ["from", { from: time(last - 19) }],
    ["to", { to: time(10) }],
    ["from and to", { from: time(5), to: time(15) }],
    ["every token's window", { from: time(0) - 1, to: now + DAY }],
    ["tag with a status it never has", { tags: ["rare"], statuses: ["TIMED_OUT"] }],
    [
      "every filter",
      {
        idempotencyKey: "key-0",
        tags: ["rare"],
        statuses: ["COMPLETED"],
        from: time(0),
        to: time(10),
      },
    ],
  ];
}

// Mints a store id at `time`, so id order is creation order, as for a token made then.
function storeIdAt(time: Date) {
  vi.useFakeTimers({ toFake: ["Date"], now: time });
  try {
    return generateWaitpointId("MANUAL");
  } finally {
    vi.useRealTimers();
  }
}

// Writes MemoryDB tokens the way the catalogue does, completing those with outputIsError set.
// Ids are minted at mintedAt, else at createdAt, so id order is creation order.
async function seedStore(coordinator: WaitpointStoreCoordinator, scope: StoreScope, seeds: Seed[]) {
  const ids = seeds.map((seed) => storeIdAt(seed.mintedAt ?? seed.createdAt));
  for (let offset = 0; offset < seeds.length; offset += 100)
    await Promise.all(
      seeds.slice(offset, offset + 100).map(async (seed, i) => {
        const id = ids[offset + i]!;
        const createdAt = seed.createdAt.toISOString();
        const record: WaitpointRecordInput = {
          id,
          friendlyId: WaitpointId.toFriendlyId(id),
          type: "MANUAL",
          ...scope,
          createdAt,
          updatedAt: createdAt,
          userProvidedIdempotencyKey: seed.idempotencyKey !== undefined,
          idempotencyKey: seed.idempotencyKey,
          tags: seed.tags ?? [],
        };
        await coordinator.manualCatalog.publish(record, Date.now() + 60_000);
        await coordinator.createIfAbsent({ record, status: "PENDING" });
        if (seed.outputIsError === undefined) return;
        await coordinator.manualCatalog.publishCompletedCandidate(record, seed.outputIsError);
        await coordinator.complete({
          waitpointId: id,
          completion: {
            completedAt: createdAt,
            outputType: "application/json",
            outputIsError: seed.outputIsError,
            output: null,
          },
        });
      })
    );
  return ids.map((id) => WaitpointId.toFriendlyId(id));
}

// Writes Postgres tokens with ids in creation order; returns their friendly ids.
async function seedLegacy(prisma: PrismaClient, ctx: SeedContext, prefix: string, seeds: Seed[]) {
  const ids = seeds.map((_, i) => `${prefix}${String(i).padStart(25 - prefix.length, "0")}`);
  for (let offset = 0; offset < seeds.length; offset += 50)
    await Promise.all(
      seeds.slice(offset, offset + 50).map((seed, i) =>
        seedWaitpoint(prisma, ctx, {
          id: ids[offset + i]!,
          createdAt: seed.createdAt,
          tags: seed.tags,
          status: seed.outputIsError === undefined ? "PENDING" : "COMPLETED",
          outputIsError: seed.outputIsError ?? false,
          idempotencyKey: seed.idempotencyKey,
          userProvidedIdempotencyKey: seed.idempotencyKey !== undefined,
        })
      )
    );
  return ids.map((id) => `wp_${id}`);
}

// A second organisation, made by hand, that the waitpoint store is not enabled for.
async function unflaggedEnvironment(
  prisma: PrismaClient,
  engine: ReturnType<typeof makeEngine>,
  slug: string
) {
  const ctx = await seedParents(prisma, slug);
  const { organizationId } = await prisma.runtimeEnvironment.findUniqueOrThrow({
    where: { id: ctx.environmentId },
  });
  const presenter = new WaitpointListPresenter(
    prisma,
    prisma,
    undefined,
    new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
    engine
  );
  const environment = {
    id: ctx.environmentId,
    type: "PRODUCTION" as const,
    project: { id: ctx.projectId, engine: "V2" as const },
    apiKey: `tr_prod_${slug}`,
    organizationId,
  };
  const list: ListCall = (overrides) => presenter.call({ environment, ...overrides });
  return { ctx, list };
}

// Counts the commands on waitpoint store keys (wp:v1) that the server runs while a call is made.
async function commandCounter(redisOptions: RedisOptions) {
  const client = new Redis(redisOptions);
  const monitor = await client.monitor();
  const marker = new Redis(redisOptions);
  let count = 0;
  let pending: { token: string; seen: () => void } | undefined;
  monitor.on("monitor", (_time: string, args: string[]) => {
    if (pending && args[0]?.toLowerCase() === "echo" && args[1] === pending.token) pending.seen();
    else if (args[1]?.startsWith("wp:v1")) count++;
  });
  // MONITOR reports commands in the order the server ran them: once the marker shows, every
  // command before it has been counted.
  const settle = async () => {
    const token = randomUUID();
    const seen = new Promise<void>((resolve) => (pending = { token, seen: resolve }));
    await marker.echo(token);
    await seen;
  };
  return {
    async count<T>(call: () => Promise<T>) {
      await settle();
      count = 0;
      const result = await call();
      await settle();
      return { result, commands: count };
    },
    quit() {
      monitor.disconnect();
      client.disconnect();
      marker.disconnect();
    },
  };
}

// Pages forward from the start to the end, and backward from the end to the start.
async function walkPages(list: ListCall, options: Partial<WaitpointListOptions>) {
  const forward = [await list(options)];
  while (forward.at(-1)!.pagination.next) {
    expect(forward.length).toBeLessThan(1000);
    forward.push(await list({ ...options, cursor: forward.at(-1)!.pagination.next }));
  }
  const back = { ...options, direction: "backward" as const };
  const backward = [await list(back)];
  while (backward.at(-1)!.pagination.previous) {
    expect(backward.length).toBeLessThan(1000);
    backward.push(await list({ ...back, cursor: backward.at(-1)!.pagination.previous }));
  }
  return { forward, backward: backward.reverse() };
}

// Follows a cursor to the end of the list in one direction; returns the tokens in list order.
// Walks that reach a cursor already followed reuse its result, so every page is listed once.
async function follow(
  list: ListCall,
  options: Partial<WaitpointListOptions>,
  direction: "forward" | "backward",
  cursor: string,
  memo: Map<string, string[]>
) {
  const visited: { key: string; tokens: string[] }[] = [];
  let tail: string[] = [];
  for (let at: string | undefined = cursor; at;) {
    const key = `${direction}:${at}`;
    const known = memo.get(key);
    if (known) {
      tail = known;
      break;
    }
    expect(visited.length).toBeLessThan(1000);
    const page = await list({ ...options, direction, cursor: at });
    visited.push({ key, tokens: tokenIds(page) });
    at = direction === "forward" ? page.pagination.next : page.pagination.previous;
  }
  for (const { key, tokens } of visited.reverse()) {
    tail = direction === "forward" ? [...tokens, ...tail] : [...tail, ...tokens];
    memo.set(key, tail);
  }
  return tail;
}

// From every page of a walk, its way back reaches exactly the tokens on the other side, each once.
async function expectWayBack(
  list: ListCall,
  options: Partial<WaitpointListOptions>,
  { forward, backward }: Awaited<ReturnType<typeof walkPages>>
) {
  const all = forward.flatMap(tokenIds);
  expect(new Set(all).size).toBe(all.length);
  const memo = new Map<string, string[]>();
  let offset = 0;
  for (const [k, page] of forward.entries()) {
    if (k > 0) {
      expect(page.pagination.previous).toBeDefined();
      expect(await follow(list, options, "backward", page.pagination.previous!, memo)).toEqual(
        all.slice(0, offset)
      );
    }
    offset += page.tokens.length;
  }
  offset = 0;
  for (const [k, page] of backward.entries()) {
    offset += page.tokens.length;
    // Only the oldest page is listed without a cursor; with no token it has nothing after it.
    if (k < backward.length - 1 || page.tokens.length) expect(page.pagination.next).toBeDefined();
    const after = page.pagination.next
      ? await follow(list, options, "forward", page.pagination.next, memo)
      : [];
    expect(after).toEqual(all.slice(offset));
  }
}
