import { describe, expect, vi } from "vitest";

// The presenter graph imports `~/services/clickhouse/clickhouseFactoryInstance.server` and, via
// NextRunListPresenter -> RunsRepository / runStore, reaches `~/db.server`'s `prisma`/`$replica`
// singletons (through findDisplayableEnvironment + getTaskIdentifiers). We stub those two wiring
// boundaries so the module loads + the connected-runs hydrate can be pointed at the per-test REAL
// containers. The DB is NEVER mocked: every assertion runs against real Postgres/ClickHouse.
//
//  * `~/db.server` — `prisma`/`$replica`/`runOpsNewPrisma` singletons. The read-through cases pass
//    explicit client handles to the presenter ctor so these proxies are never read on those paths.
//    For the connected-runs hydrate the proxies forward lazily to the test's real legacy handle.
//    The run-ops new/legacy clients forward to the new/legacy per-test holders respectively.
//  * clickhouseFactory singleton — overridden to hand back the per-test ClickHouse so the
//    connected-runs hydrate uses a real CH container (a wiring override, not a DB mock).
const legacyReplicaHolder = vi.hoisted(() => ({ client: undefined as any }));
const newClientHolder = vi.hoisted(() => ({ client: undefined as any }));
const clickhouseHolder = vi.hoisted(() => ({ client: undefined as any }));

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
  return {
    prisma: replicaProxy,
    $replica: replicaProxy,
    runOpsNewPrisma: lazyProxy(newClientHolder, "newClientHolder.client"),
    runOpsNewReplica: lazyProxy(newClientHolder, "newClientHolder.client"),
    runOpsLegacyPrisma: replicaProxy,
    runOpsLegacyReplica: replicaProxy,
    sqlDatabaseSchema: Prisma.sql([`public`]),
    DATABASE_SCHEMA: "public",
  };
});

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

import {
  createPostgresContainer,
  heteroPostgresTest,
  replicationContainerTest,
} from "@internal/testcontainers";
import type { PrismaClient, WaitpointType } from "@trigger.dev/database";
import { PrismaClient as PrismaClientCtor } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import type { PrismaReplicaClient } from "~/db.server";
import { WaitpointPresenter } from "~/presenters/v3/WaitpointPresenter.server";
import { setupClickhouseReplication } from "./utils/replicationUtils";

vi.setConfig({ testTimeout: 90_000 });

// A read client whose waitpoint.findFirst calls are recorded, split by kind. The presenter issues
// two shapes of waitpoint.findFirst: a HYDRATE (loads the waitpoint scalar row -- no `connectedRuns`
// in its select) and a connectedRuns-RELATION read (control-plane branch of the connected-runs
// gather -- select is exactly `{ connectedRuns }`). The `forbidden` guard throws ONLY on a HYDRATE,
// so a store can be proven to never be HYDRATED while still allowing the connectedRuns cross-DB
// union to legitimately read it (that union always touched both stores; it was invisible when the
// old code did it via raw SQL). Every other access forwards to the real client.
function recording(client: PrismaClient, opts: { forbidden?: boolean } = {}) {
  const calls: unknown[] = [];
  const hydrateCalls: unknown[] = [];
  const connectedRunsCalls: unknown[] = [];
  return {
    handle: new Proxy(client, {
      get(target, prop) {
        if (prop === "waitpoint") {
          return new Proxy((target as any).waitpoint, {
            get(wpTarget, wpProp) {
              if (wpProp === "findFirst") {
                return (args: unknown) => {
                  calls.push(args);
                  const select = (args as { select?: Record<string, unknown> })?.select ?? {};
                  const keys = Object.keys(select);
                  const isConnectedRunsRead = keys.length === 1 && keys[0] === "connectedRuns";
                  if (isConnectedRunsRead) {
                    connectedRunsCalls.push(args);
                  } else {
                    hydrateCalls.push(args);
                    if (opts.forbidden) {
                      throw new Error("this store must never be hydrated");
                    }
                  }
                  return (wpTarget as any).findFirst(args);
                };
              }
              return (wpTarget as any)[wpProp];
            },
          });
        }
        return (target as any)[prop];
      },
    }) as unknown as PrismaReplicaClient,
    calls,
    hydrateCalls,
    connectedRunsCalls,
  };
}

type SeedContext = {
  organizationId: string;
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

/** Mirrors the org/project/env parents onto a second DB with the SAME ids (FKs need them). */
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

async function seedWaitpoint(
  prisma: PrismaClient,
  ctx: SeedContext,
  friendlyId: string,
  overrides: Partial<{
    type: WaitpointType;
    tags: string[];
    output: string;
    connectedRunFriendlyIds: string[];
  }> = {}
) {
  return prisma.waitpoint.create({
    data: {
      friendlyId,
      type: overrides.type ?? "MANUAL",
      status: "COMPLETED",
      idempotencyKey: `idem-${friendlyId}`,
      userProvidedIdempotencyKey: false,
      output: overrides.output ?? JSON.stringify({ hello: "world" }),
      outputType: "application/json",
      outputIsError: false,
      completedAt: new Date(),
      tags: overrides.tags ?? ["a", "b"],
      projectId: ctx.projectId,
      environmentId: ctx.environmentId,
      ...(overrides.connectedRunFriendlyIds
        ? {
            connectedRuns: {
              connect: overrides.connectedRunFriendlyIds.map((friendlyId) => ({ friendlyId })),
            },
          }
        : {}),
    },
  });
}

async function createRun(
  prisma: PrismaClient,
  ctx: SeedContext,
  run: { friendlyId: string; taskIdentifier?: string }
) {
  return prisma.taskRun.create({
    data: {
      friendlyId: run.friendlyId,
      taskIdentifier: run.taskIdentifier ?? "my-task",
      status: "PENDING",
      payload: JSON.stringify({ foo: run.friendlyId }),
      traceId: run.friendlyId,
      spanId: run.friendlyId,
      queue: "test",
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
    },
  });
}

const callArgs = (ctx: SeedContext, friendlyId: string) => ({
  friendlyId,
  environmentId: ctx.environmentId,
  projectId: ctx.projectId,
});

describe("WaitpointPresenter dual-DB read-through (hetero PG14 + PG17, no connected runs)", () => {
  // new-DB short-circuit. Waitpoint on NEW (PG17), legacy
  // wrapped so its waitpoint.findFirst throws if invoked. The lookup answers from NEW and must
  // NEVER fall through to legacy.
  heteroPostgresTest(
    "waitpoint on the new DB resolves without touching the legacy replica",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma17, "newonly");
      const seeded = await seedWaitpoint(prisma17, ctx, "waitpoint_newonly");

      // The env lives on the new DB here; the resolver singleton reads it through the
      // `~/db.server` proxy.
      legacyReplicaHolder.client = prisma17;

      const newClient = recording(prisma17);
      const legacy = recording(prisma14, { forbidden: true });

      const presenter = new WaitpointPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: newClient.handle,
        legacyReplica: legacy.handle,
      });

      const result = await presenter.call(callArgs(ctx, seeded.friendlyId));

      expect(result?.id).toBe(seeded.friendlyId);
      // New-first short-circuit: the HYDRATE answered from new and never fell through to a legacy
      // hydrate (the throwing handle proves it). The connectedRuns cross-DB union still reads legacy
      // legitimately -- that read is allowed and must NOT count as a hydrate.
      expect(newClient.hydrateCalls.length).toBe(1);
      expect(legacy.hydrateCalls.length).toBe(0);
      expect(legacy.connectedRunsCalls.length).toBeGreaterThan(0);
    }
  );

  // single-DB passthrough. No read-through deps -> exactly one plain
  // findFirst against the single `_replica` handle; the split branch is structurally never entered
  // (no second handle is injected). The connected-runs hydrate forwards `undefined` deps.
  heteroPostgresTest(
    "no read-through deps -> one plain findFirst on the single replica (passthrough)",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "passthrough");
      const seeded = await seedWaitpoint(prisma14, ctx, "waitpoint_passthrough", {
        tags: ["one"],
      });

      const single = recording(prisma14);
      const second = recording(prisma17, { forbidden: true });
      legacyReplicaHolder.client = single.handle;
      newClientHolder.client = second.handle;

      // No readThroughDeps -> ctor defaults _replica to the (mocked) `$replica` singleton, which
      // forwards to `single.handle`. The split branch needs an injected second handle to fire, so
      // it cannot: passthrough is structural.
      const presenter = new WaitpointPresenter();

      const result = await presenter.call(callArgs(ctx, seeded.friendlyId));

      expect(result?.id).toBe(seeded.friendlyId);
      expect(result?.tags).toEqual(["one"]);
      // Two reads on the single client, both on the one handle: the first findFirst hydrates the
      // waitpoint, the second loads the `connectedRuns` relation (the implicit M2M has no queryable
      // join delegate, so the ORM must traverse the relation with a second findFirst). The second
      // handle is never touched -- passthrough is structural, the split branch never fires.
      expect(single.calls.length).toBe(2);
      expect(second.calls.length).toBe(0);
    }
  );
});

describe("WaitpointPresenter connected-runs hydrate routed through read-through (PG14 + PG17 + CH)", () => {
  // Waitpoint detail + connected runs resolve on run-ops NEW. The
  // waitpoint + its 2 connected runs live on the new (PG17) DB; CH gets the run id-set so the
  // threaded NextRunListPresenter hydrate returns them. Proves the read-through deps are forwarded
  // so the connected-runs hydrate flows through the routed store.
  replicationContainerTest(
    "waitpoint + 2 connected runs resolve on the new DB via the routed hydrate",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma, network }) => {
      // `prisma`/`postgresContainer` is the PG14 legacy + CH replication source. The new DB (PG17)
      // is created alongside; we seed the waitpoint + runs on it so CH replicates from PG14 — so we
      // mirror the runs onto PG14 (replication source) and the waitpoint+runs onto PG17 (authoritative).
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const { url: newUrl } = await createPostgresContainer(network, {
        imageTag: "docker.io/postgres:17",
      });
      const prismaNew = new PrismaClientCtor({ datasources: { db: { url: newUrl } } });
      legacyReplicaHolder.client = prisma;
      newClientHolder.client = prismaNew;
      clickhouseHolder.client = clickhouse;

      try {
        const ctx = await seedParents(prisma, "connectednew");
        await mirrorParents(prismaNew, ctx, "connectednew");

        // The connected runs land on PG14 (CH replication source) AND on PG17 (authoritative,
        // same ids/friendlyIds) so the routed hydrate resolves them from NEW.
        const runA = await createRun(prisma, ctx, { friendlyId: "run_connA" });
        const runB = await createRun(prisma, ctx, { friendlyId: "run_connB" });
        const newRunA = await createRun(prismaNew, ctx, {
          friendlyId: "run_connA",
          taskIdentifier: "my-task-NEW",
        });
        const newRunB = await createRun(prismaNew, ctx, {
          friendlyId: "run_connB",
          taskIdentifier: "my-task-NEW",
        });
        await prismaNew.taskRun.update({
          where: { friendlyId: "run_connA" },
          data: { id: runA.id },
        });
        await prismaNew.taskRun.update({
          where: { friendlyId: "run_connB" },
          data: { id: runB.id },
        });

        // Waitpoint authoritative on NEW, connected to the 2 runs.
        const seeded = await seedWaitpoint(prismaNew, ctx, "waitpoint_connectednew", {
          connectedRunFriendlyIds: ["run_connA", "run_connB"],
        });

        // Wait for CH replication so the connected-run id-set page is non-empty.
        await setTimeout(1500);

        const presenter = new WaitpointPresenter(prisma, prisma, {
          splitEnabled: true,
          newClient: prismaNew,
          legacyReplica: prisma,
        });

        const result = await presenter.call(callArgs(ctx, seeded.friendlyId));

        expect(result?.id).toBe(seeded.friendlyId);
        expect(result?.connectedRuns.map((r) => r.friendlyId).sort()).toEqual([
          "run_connA",
          "run_connB",
        ]);
        // The connected runs carry the PG17-only taskIdentifier -> they hydrated from the threaded
        // newClient (PG17), proving the routed store is armed.
        expect(result?.connectedRuns.every((r) => r.taskIdentifier === "my-task-NEW")).toBe(true);
        void newRunA;
        void newRunB;
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );
});

describe("WaitpointPresenter bare-ctor production default activates readThroughRun", () => {
  heteroPostgresTest(
    "run-ops waitpoint on the new DB resolves via readThroughRun production defaults",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma17, "proddefault");
      const seeded = await seedWaitpoint(prisma17, ctx, "waitpoint_proddefault", {
        tags: ["p", "q"],
      });

      // runOpsNewReplica default -> PG17; env resolver reads via legacyReplicaHolder.
      newClientHolder.client = prisma17;
      legacyReplicaHolder.client = prisma17;

      // No newClient/legacyReplica injected — production ctor shape.
      const presenter = new WaitpointPresenter(undefined, undefined, { splitEnabled: true });

      const result = await presenter.call(callArgs(ctx, seeded.friendlyId));

      expect(result?.id).toBe(seeded.friendlyId);
      expect(result?.tags).toEqual(["p", "q"]);
    }
  );
});
