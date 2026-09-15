// Replica-lag properties for the waitpoint-family dashboard/API read presenters. Every read here is
// served by the OWNING store's REPLICA (no client passed) and backs a display/GET/list view, so each
// tolerates the lag. On the real split topology (heteroRunOpsPostgresTest, never mocked) we freeze the
// owning (LEGACY) replica via a local proxy that also freezes the $queryRaw connected-run lookup (which
// the shared laggingReplica primitive can't intercept), invoke each read EXACTLY as its
// caller does, assert the stale-under-lag value, and prove the row exists on the PRIMARY (so the miss
// is pure lag). A caller-passed primary client flips the read to the owning primary.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

const CUID_25 = "e".repeat(25); // cuid id-shape -> LEGACY (#legacy / prisma14, full schema)

// A recording "replica" that has NOT caught up: `taskRun`, `waitpoint`, and `waitpointTag` MODEL reads
// come back empty, and `$queryRaw`/`$queryRawUnsafe` (the connection-join lookups) come back empty too,
// so any replica-routed read misses the just-written row. Everything else forwards to the real client.
// `wasHit` flips true iff an intercepted read was routed here. Writes always land on the PRIMARY
// (this.prisma), so freezing the readOnly client never affects seeding.
function laggingReplica<C extends AnyClient>(real: C): { client: C; wasHit: () => boolean } {
  let hit = false;
  function wrapModel(target: any) {
    return new Proxy(target, {
      get(innerTarget, prop) {
        if (prop === "findFirst" || prop === "findMany" || prop === "findUnique") {
          return async () => {
            hit = true;
            return prop === "findMany" ? [] : null;
          };
        }
        if (prop === "findFirstOrThrow" || prop === "findUniqueOrThrow") {
          return async () => {
            hit = true;
            throw new Error("lagging replica: row not visible");
          };
        }
        return (innerTarget as any)[prop];
      },
    });
  }
  const laggingTaskRun = wrapModel((real as any).taskRun);
  const laggingWaitpoint = wrapModel((real as any).waitpoint);
  const laggingWaitpointTag = wrapModel((real as any).waitpointTag);
  const client = new Proxy(real, {
    get(target, prop) {
      if (prop === "taskRun") return laggingTaskRun;
      if (prop === "waitpoint") return laggingWaitpoint;
      if (prop === "waitpointTag") return laggingWaitpointTag;
      // The connection-id gather runs a raw JOIN (findWaitpointConnectedRunIds); a lagging replica
      // has none of those rows yet, so freeze raw reads to empty as well.
      if (prop === "$queryRaw" || prop === "$queryRawUnsafe") {
        return async () => {
          hit = true;
          return [];
        };
      }
      return (target as any)[prop];
    },
  }) as C;
  return { client, wasHit: () => hit };
}

async function seedEnvironmentLegacy(prisma: PrismaClient, suffix: string) {
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
  return { organization, project, environment };
}

// Build a LEGACY-owning router whose legacy replica is frozen (lagging); the NEW store is real
// (non-lagging) so the on-miss fan-out to the other store's replica also legitimately misses.
function buildRouterWithLaggingLegacyReplica(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyReplica = laggingReplica(prisma14);
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: legacyReplica.client,
    schemaVariant: "legacy",
  });
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
  return { router, legacyStore, legacyReplica };
}

// Seed a standalone MANUAL token waitpoint on the WRITER (exactly as minting a resume token does).
async function seedManualWaitpoint(
  store: PostgresRunStore,
  params: {
    id: string;
    friendlyId: string;
    projectId: string;
    environmentId: string;
    tags?: string[];
  }
) {
  await store.upsertWaitpoint({
    where: {
      environmentId_idempotencyKey: {
        environmentId: params.environmentId,
        idempotencyKey: params.id,
      },
    },
    create: {
      id: params.id,
      friendlyId: params.friendlyId,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: params.id,
      userProvidedIdempotencyKey: false,
      projectId: params.projectId,
      environmentId: params.environmentId,
      ...(params.tags ? { tags: params.tags } : {}),
    },
    update: {},
  });
}

function taskRunData(opts: {
  id: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}) {
  return {
    id: opts.id,
    engine: "V2" as const,
    status: "COMPLETED_SUCCESSFULLY" as const,
    friendlyId: opts.friendlyId,
    runtimeEnvironmentId: opts.runtimeEnvironmentId,
    environmentType: "DEVELOPMENT" as const,
    organizationId: opts.organizationId,
    projectId: opts.projectId,
    taskIdentifier: "my-task",
    payload: JSON.stringify({ hello: "world" }),
    payloadType: "application/json",
    traceContext: {},
    traceId: `trace_${opts.id}`,
    spanId: `span_${opts.id}`,
    queue: "task/my-task",
    isTest: false,
    taskEventStore: "taskEvent",
    depth: 0,
  };
}

// ── Exact projections the call sites read ─────────────────────────────────────────────────────────
const API_WAITPOINT_SELECT = {
  id: true,
  friendlyId: true,
  type: true,
  status: true,
  idempotencyKey: true,
  userProvidedIdempotencyKey: true,
  idempotencyKeyExpiresAt: true,
  inactiveIdempotencyKey: true,
  output: true,
  outputType: true,
  outputIsError: true,
  completedAfter: true,
  completedAt: true,
  createdAt: true,
  tags: true,
} as const;

const LIST_WAITPOINT_SELECT = {
  id: true,
  friendlyId: true,
  status: true,
  completedAt: true,
  completedAfter: true,
  outputIsError: true,
  idempotencyKey: true,
  idempotencyKeyExpiresAt: true,
  inactiveIdempotencyKey: true,
  userProvidedIdempotencyKey: true,
  tags: true,
  createdAt: true,
} as const;

const DETAIL_WAITPOINT_SELECT = {
  id: true,
  friendlyId: true,
  type: true,
  status: true,
  idempotencyKey: true,
  userProvidedIdempotencyKey: true,
  idempotencyKeyExpiresAt: true,
  inactiveIdempotencyKey: true,
  output: true,
  outputType: true,
  outputIsError: true,
  completedAfter: true,
  completedAt: true,
  createdAt: true,
  tags: true,
  environmentId: true,
} as const;

describe("waitpoint-family dashboard/API read presenters under replica lag", () => {
  // ApiWaitpointPresenter (GET retrieve loader).
  heteroRunOpsPostgresTest(
    "ApiWaitpointPresenter findWaitpoint(id) is null under lag; the owning primary resolves it",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouterWithLaggingLegacyReplica(
        prisma14,
        prisma17
      );
      const seed = await seedEnvironmentLegacy(prisma14, "api_wp");
      const waitpointId = `waitpoint_${CUID_25}`; // cuid → LEGACY
      await seedManualWaitpoint(legacyStore, {
        id: waitpointId,
        friendlyId: "waitpoint_api_wp",
        projectId: seed.project.id,
        environmentId: seed.environment.id,
      });

      // Exact caller read: select the api projection, where {id, environmentId}, NO client → owning replica.
      const fromReplica = await router.findWaitpoint({
        where: { id: waitpointId, environmentId: seed.environment.id },
        select: API_WAITPOINT_SELECT,
      });
      // Stale: owning replica lags → null. The route's `if (!waitpoint) throw "Waitpoint not found"`
      // fires — a transient error on a read-only GET loader; the client re-requests the retrieve.
      // This gates NO write (the mint POST + complete path use their own primary reads), so tolerated.
      expect(fromReplica).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // Prove the null is lag, not absence: the same call on the owning PRIMARY resolves the token.
      const fromPrimary = await router.findWaitpoint(
        {
          where: { id: waitpointId, environmentId: seed.environment.id },
          select: API_WAITPOINT_SELECT,
        },
        prisma14
      );
      expect(fromPrimary).not.toBeNull();
      expect(fromPrimary!.friendlyId).toBe("waitpoint_api_wp");
      expect(fromPrimary!.type).toBe("MANUAL");
    }
  );

  // WaitpointListPresenter findManyWaitpoints.
  heteroRunOpsPostgresTest(
    "WaitpointListPresenter findManyWaitpoints is empty under lag; the primary returns the token",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouterWithLaggingLegacyReplica(
        prisma14,
        prisma17
      );
      const seed = await seedEnvironmentLegacy(prisma14, "list_many");
      const waitpointId = `waitpoint_${CUID_25}`;
      await seedManualWaitpoint(legacyStore, {
        id: waitpointId,
        friendlyId: "waitpoint_list_many",
        projectId: seed.project.id,
        environmentId: seed.environment.id,
      });

      // Exact caller read: MANUAL scan, keyset order, over-fetch window, NO client → both replicas.
      const fromReplica = await router.findManyWaitpoints({
        where: { environmentId: seed.environment.id, type: "MANUAL" },
        orderBy: { id: "desc" },
        take: 26,
        select: LIST_WAITPOINT_SELECT,
      });
      // Stale: both replicas empty (new has no row; legacy replica frozen). The list simply omits the
      // token this render; the next fetch (once caught up) shows it. No write/decision on the stale set.
      expect(fromReplica).toEqual([]);
      expect(legacyReplica.wasHit()).toBe(true);

      // Prove pure lag: the same scan on the owning primary returns the token.
      const fromPrimary = await router.findManyWaitpoints(
        {
          where: { environmentId: seed.environment.id, type: "MANUAL" },
          orderBy: { id: "desc" },
          take: 26,
          select: LIST_WAITPOINT_SELECT,
        },
        prisma14
      );
      expect(fromPrimary).toHaveLength(1);
      expect(fromPrimary[0]!.friendlyId).toBe("waitpoint_list_many");
    }
  );

  // WaitpointListPresenter #probeAnyToken findWaitpoint.
  heteroRunOpsPostgresTest(
    "WaitpointListPresenter probe findWaitpoint(MANUAL) is null under lag; the primary finds the token",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouterWithLaggingLegacyReplica(
        prisma14,
        prisma17
      );
      const seed = await seedEnvironmentLegacy(prisma14, "probe_any");
      const waitpointId = `waitpoint_${CUID_25}`;
      await seedManualWaitpoint(legacyStore, {
        id: waitpointId,
        friendlyId: "waitpoint_probe_any",
        projectId: seed.project.id,
        environmentId: seed.environment.id,
      });

      // Exact caller read: no id, no select — fan NEW-then-LEGACY on each store's replica.
      const fromReplica = await router.findWaitpoint({
        where: { environmentId: seed.environment.id, type: "MANUAL" },
      });
      // Stale null → hasAnyTokens=false. The only user-visible effect is which empty-state copy renders
      // ("get started" vs "no matches"); it drives no write and self-corrects on the next render.
      expect(fromReplica).toBeNull();
      const hasAnyTokensUnderLag = Boolean(fromReplica);
      expect(hasAnyTokensUnderLag).toBe(false);
      expect(legacyReplica.wasHit()).toBe(true);

      // Prove pure lag: the same probe on the owning primary finds a MANUAL token (hasAnyTokens=true).
      const fromPrimary = await router.findWaitpoint(
        { where: { environmentId: seed.environment.id, type: "MANUAL" } },
        prisma14
      );
      expect(fromPrimary).not.toBeNull();
    }
  );

  // WaitpointPresenter #findWaitpoint(friendlyId).
  heteroRunOpsPostgresTest(
    "WaitpointPresenter findWaitpoint(friendlyId) is null under lag; the primary resolves it",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouterWithLaggingLegacyReplica(
        prisma14,
        prisma17
      );
      const seed = await seedEnvironmentLegacy(prisma14, "detail_wp");
      const waitpointId = `waitpoint_${CUID_25}`;
      const friendlyId = "waitpoint_detail_wp";
      await seedManualWaitpoint(legacyStore, {
        id: waitpointId,
        friendlyId,
        projectId: seed.project.id,
        environmentId: seed.environment.id,
      });

      // Exact caller read: where {friendlyId, environmentId} (no id) + detail select, NO client → replicas.
      const fromReplica = await router.findWaitpoint({
        where: { friendlyId, environmentId: seed.environment.id },
        select: DETAIL_WAITPOINT_SELECT,
      });
      // Stale null → presenter.call logs "Waitpoint not found" and returns null; the detail page shows
      // not-found and the user reloads. Read-only render, no mutation gated. Tolerated.
      expect(fromReplica).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      const fromPrimary = await router.findWaitpoint(
        {
          where: { friendlyId, environmentId: seed.environment.id },
          select: DETAIL_WAITPOINT_SELECT,
        },
        prisma14
      );
      expect(fromPrimary).not.toBeNull();
      expect(fromPrimary!.environmentId).toBe(seed.environment.id);
    }
  );

  // WaitpointPresenter findWaitpointConnectedRunIds.
  heteroRunOpsPostgresTest(
    "WaitpointPresenter findWaitpointConnectedRunIds is empty under lag; the primary returns the connection",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouterWithLaggingLegacyReplica(
        prisma14,
        prisma17
      );
      const seed = await seedEnvironmentLegacy(prisma14, "conn_ids");
      const waitpointId = `waitpoint_${CUID_25}`;
      const runId = `run_${CUID_25}`; // cuid → LEGACY, co-located with the token
      await seedManualWaitpoint(legacyStore, {
        id: waitpointId,
        friendlyId: "waitpoint_conn_ids",
        projectId: seed.project.id,
        environmentId: seed.environment.id,
      });
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: "run_conn_ids",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });
      // The run↔waitpoint join is written on the run's DB (blockRunWithWaitpointEdges, routed by runId).
      await router.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [waitpointId],
        projectId: seed.project.id,
      });

      // Exact caller read: fan the connection JOIN across both stores' replicas, NO client.
      const fromReplica = await router.findWaitpointConnectedRunIds(waitpointId);
      // Stale: both replicas' join reads empty (new has none; legacy replica raw frozen). The detail
      // page shows an empty/partial "connected runs" list; a refresh fills it. Pure display.
      expect(fromReplica).toEqual([]);
      expect(legacyReplica.wasHit()).toBe(true);

      // Prove pure lag: the same fan-out on the owning primary returns the connected run id.
      const fromPrimary = await router.findWaitpointConnectedRunIds(waitpointId, prisma14);
      expect(fromPrimary).toEqual([runId]);
    }
  );

  // WaitpointPresenter findRuns({id:{in}}).
  heteroRunOpsPostgresTest(
    "WaitpointPresenter findRuns(id in) is empty under lag; the primary returns the run",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica } = buildRouterWithLaggingLegacyReplica(prisma14, prisma17);
      const seed = await seedEnvironmentLegacy(prisma14, "conn_runs");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: "run_conn_runs",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });

      // Exact caller read: id-set + friendlyId projection + take, NO client → owning replica(s).
      const fromReplica = (await router.findRuns({
        where: { id: { in: [runId] } },
        select: { friendlyId: true },
        take: 5,
      })) as Array<{ friendlyId: string }>;
      // Stale: owning replica lags → []; the detail page's connected-runs block renders nothing this
      // pass. The set is only mapped to friendlyIds for display — no decision on the stale result.
      expect(fromReplica).toEqual([]);
      expect(legacyReplica.wasHit()).toBe(true);

      // Prove pure lag: the same query on the owning primary returns the run's friendlyId.
      const fromPrimary = (await router.findRuns(
        { where: { id: { in: [runId] } }, select: { friendlyId: true }, take: 5 },
        prisma14
      )) as Array<{ friendlyId: string }>;
      expect(fromPrimary).toHaveLength(1);
      expect(fromPrimary[0]!.friendlyId).toBe("run_conn_runs");
    }
  );

  // WaitpointTagListPresenter findManyWaitpointTags.
  heteroRunOpsPostgresTest(
    "WaitpointTagListPresenter findManyWaitpointTags is empty under lag; the primary returns the tag",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouterWithLaggingLegacyReplica(
        prisma14,
        prisma17
      );
      const seed = await seedEnvironmentLegacy(prisma14, "tag_list");
      await legacyStore.upsertWaitpointTag({
        environmentId: seed.environment.id,
        name: "my-tag",
        projectId: seed.project.id,
      });

      // Exact caller read: env + optional name filter, orderBy id desc, over-fetch window, NO client.
      const fromReplica = await router.findManyWaitpointTags({
        where: { environmentId: seed.environment.id, name: undefined },
        orderBy: { id: "desc" },
        take: 26,
        skip: 0,
      });
      // Stale: both replicas' waitpointTag reads empty. The tag filter dropdown omits the new tag this
      // render; it appears once the replica catches up. No write/decision.
      expect(fromReplica).toEqual([]);
      expect(legacyReplica.wasHit()).toBe(true);

      // Prove pure lag: the same query on the owning primary returns the tag.
      const fromPrimary = await router.findManyWaitpointTags(
        {
          where: { environmentId: seed.environment.id, name: undefined },
          orderBy: { id: "desc" },
          take: 26,
          skip: 0,
        },
        prisma14
      );
      expect(fromPrimary).toHaveLength(1);
      expect(fromPrimary[0]!.name).toBe("my-tag");
    }
  );
});
