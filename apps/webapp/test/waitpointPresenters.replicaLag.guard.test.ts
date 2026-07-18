// Property: the waitpoint-family READ presenters behave correctly under replica lag. Drives the REAL
// exported presenter classes (ApiWaitpointPresenter, WaitpointListPresenter, WaitpointPresenter,
// WaitpointTagListPresenter) through the REAL split RoutingRunStore over two testcontainer Postgres DBs
// (heteroRunOpsPostgresTest), the owning (LEGACY / control-plane) REPLICA frozen behind the shared
// laggingReplica, injected as the presenter's `runStore` arg. Only peripheral webapp singletons
// (db.server clients, runStore.server, logger, httpCallback URL, engine-version gate, clickhouse
// factory, control-plane env resolver, NextRunListPresenter leaf, ServiceValidationError) are stubbed.
//
// What each case proves, from the real caller's observable output under lag:
//   1  ApiWaitpointPresenter findWaitpoint — recovers a LIVE token on a replica miss via a
//      findWaitpointOnPrimary fallback (returns the token; absent the fallback it throws
//      "Waitpoint not found").
//   2  WaitpointListPresenter findManyWaitpoints — the token list omits the just-minted token
//      (tokens: []); eventual-consistency render, no write gated.
//   3  WaitpointListPresenter findWaitpoint — #probeAnyToken → hasAnyTokens false → cosmetic
//      "no tokens yet" copy; self-heals next fetch.
//   4  WaitpointPresenter findWaitpoint — dashboard DETAIL loader returns null → not-found render;
//      the user reloads. No write.
//   5  WaitpointPresenter findWaitpointConnectedRunIds — connected-runs sub-list empty on the detail
//      render (connectedRuns: []); display only.
//   6  WaitpointPresenter findRuns — connected-run friendlyIds unresolved (connectedRuns: []) though
//      the connection id was gathered; display only.
//   7  WaitpointTagListPresenter findManyWaitpointTags — tag-filter dropdown omits a just-created tag
//      (tags: []); eventual-consistency list, no write.
//
// For cases 2-7, the test additionally drives the SAME presenter over a non-lagging router to prove
// the stale value is pure lag (the row is live on the primary), not absence.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect, vi } from "vitest";

// ── Fix-orthogonal module stubs (never the run-store read path) ────────────────────────────────────
const { holder } = vi.hoisted(() => ({
  holder: { env: undefined as unknown },
}));

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/v3/runStore.server", () => ({ runStore: {} }));
vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/services/httpCallback.server", () => ({
  generateHttpCallbackUrl: () => "https://api.trigger.dev/http-callback",
}));
// ApiWaitpointPresenter imports ServiceValidationError from baseService.server, which itself drags the
// run-engine singleton at import; stub to a light Error subclass so the import graph stays cheap.
vi.mock("~/v3/services/baseService.server", () => ({
  ServiceValidationError: class ServiceValidationError extends Error {},
}));
// Engine-version gate for the token LIST presenter — return V2 so it proceeds to the read under test.
vi.mock("~/v3/engineVersion.server", () => ({
  determineEngineVersion: vi.fn(async () => "V2"),
}));
// Reached by WaitpointPresenter only when connectedRuns is non-empty — never under lag; stub so import
// resolves without the real clickhouse client.
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: vi.fn(async () => ({})) },
}));
// The detail presenter resolves the env-derived fields (apiKey/organizationId) off this control-plane
// singleton after the waitpoint read succeeds. Peripheral to the run-store read path.
vi.mock("~/v3/runOpsMigration/controlPlaneResolver.server", () => ({
  controlPlaneResolver: { resolveAuthenticatedEnv: vi.fn(async () => holder.env) },
}));
// Connected-run hydration leaf; never instantiated under lag (connectedRuns empty), but the import
// must resolve without its heavy graph.
vi.mock("~/presenters/v3/NextRunListPresenter.server", () => ({
  NextRunListPresenter: class {
    async call() {
      return { runs: [] };
    }
  },
}));

import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import { ApiWaitpointPresenter } from "~/presenters/v3/ApiWaitpointPresenter.server";
import { WaitpointListPresenter } from "~/presenters/v3/WaitpointListPresenter.server";
import { WaitpointPresenter } from "~/presenters/v3/WaitpointPresenter.server";
import { WaitpointTagListPresenter } from "~/presenters/v3/WaitpointTagListPresenter.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type AnyClient = PrismaClient | RunOpsPrismaClient;

const CUID_25 = "e".repeat(25); // cuid id-shape → LEGACY (control-plane / prisma14)

// A recording "replica" that has NOT caught up: reads for the SELECTED models/raw come back empty and
// flip `wasHit`, so a replica-routed read misses the just-written row. Everything else forwards to the
// real client (writes always land on the PRIMARY, so freezing the readOnly client never affects seeding).
function laggingReplica<C extends AnyClient>(
  real: C,
  freeze: { waitpoint?: boolean; taskRun?: boolean; waitpointTag?: boolean; raw?: boolean }
): { client: C; wasHit: () => boolean } {
  let hit = false;
  function frozenModel(target: any) {
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
  const frozenWaitpoint = freeze.waitpoint ? frozenModel((real as any).waitpoint) : undefined;
  const frozenTaskRun = freeze.taskRun ? frozenModel((real as any).taskRun) : undefined;
  const frozenWaitpointTag = freeze.waitpointTag
    ? frozenModel((real as any).waitpointTag)
    : undefined;
  const client = new Proxy(real, {
    get(target, prop) {
      if (prop === "waitpoint" && frozenWaitpoint) return frozenWaitpoint;
      if (prop === "taskRun" && frozenTaskRun) return frozenTaskRun;
      if (prop === "waitpointTag" && frozenWaitpointTag) return frozenWaitpointTag;
      if (freeze.raw && (prop === "$queryRaw" || prop === "$queryRawUnsafe")) {
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

// LEGACY-owning router whose legacy replica is frozen per `freeze`; the NEW store is real (non-lagging),
// so the on-miss fan-out to the other store's replica also legitimately misses.
function buildRouter(
  prisma14: PrismaClient,
  prisma17: RunOpsPrismaClient,
  freeze: { waitpoint?: boolean; taskRun?: boolean; waitpointTag?: boolean; raw?: boolean }
) {
  const legacyReplica = laggingReplica(prisma14, freeze);
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

// A router with a fully non-lagging legacy replica — used to prove each case's stale value is
// pure lag (the row is live on the primary), by driving the SAME presenter against it.
function buildHealthyRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  return buildRouter(prisma14, prisma17, {});
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

function apiEnvironment(env: { id: string; apiKey: string; projectId: string }) {
  return {
    id: env.id,
    type: "DEVELOPMENT" as const,
    project: { id: env.projectId, engine: "V2" as const },
    apiKey: env.apiKey,
  };
}

describe("waitpoint-family read presenters under replica lag", () => {
  // ApiWaitpointPresenter findWaitpoint — recovers a live token via a primary fallback
  heteroRunOpsPostgresTest(
    "ApiWaitpointPresenter.call resolves a live token under replica lag",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouter(prisma14, prisma17, {
        waitpoint: true,
      });
      const seed = await seedEnvironmentLegacy(prisma14, "api_wp");
      const waitpointId = `waitpoint_${CUID_25}`; // cuid → LEGACY
      await seedManualWaitpoint(legacyStore, {
        id: waitpointId,
        friendlyId: "waitpoint_api_wp",
        projectId: seed.project.id,
        environmentId: seed.environment.id,
      });

      const presenter = new ApiWaitpointPresenter(prisma14, prisma14, undefined, router);

      // The presenter's replica read misses, then re-reads the owning primary and returns the LIVE
      // token via the findWaitpointOnPrimary fallback.
      const result = await presenter.call(
        apiEnvironment({
          id: seed.environment.id,
          apiKey: seed.environment.apiKey,
          projectId: seed.project.id,
        }),
        waitpointId
      );

      // The replica WAS consulted (and, frozen, missed) — proving the recovery is the primary fallback.
      expect(legacyReplica.wasHit()).toBe(true);
      expect(result.id).toBe("waitpoint_api_wp");
      expect(result.type).toBe("MANUAL");
      expect(result.status).toBe("WAITING");
    }
  );

  // Negative control: a token that truly does not exist anywhere still throws (the fallback recovers a
  // LIVE token, it does not blanket-swallow the not-found).
  heteroRunOpsPostgresTest(
    "control: ApiWaitpointPresenter.call throws when the token is absent on the primary too",
    async ({ prisma14, prisma17 }) => {
      const { router } = buildRouter(prisma14, prisma17, { waitpoint: true });
      const seed = await seedEnvironmentLegacy(prisma14, "api_absent");
      const presenter = new ApiWaitpointPresenter(prisma14, prisma14, undefined, router);
      await expect(
        presenter.call(
          apiEnvironment({
            id: seed.environment.id,
            apiKey: seed.environment.apiKey,
            projectId: seed.project.id,
          }),
          `waitpoint_${"f".repeat(25)}`
        )
      ).rejects.toThrow(/not found/i);
    }
  );

  // WaitpointListPresenter findManyWaitpoints / findWaitpoint
  heteroRunOpsPostgresTest(
    "WaitpointListPresenter.call omits a just-minted token under replica lag",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouter(prisma14, prisma17, {
        waitpoint: true,
      });
      const seed = await seedEnvironmentLegacy(prisma14, "list");
      await seedManualWaitpoint(legacyStore, {
        id: `waitpoint_${CUID_25}`,
        friendlyId: "waitpoint_list",
        projectId: seed.project.id,
        environmentId: seed.environment.id,
      });

      const env = apiEnvironment({
        id: seed.environment.id,
        apiKey: seed.environment.apiKey,
        projectId: seed.project.id,
      });

      const laggy = await new WaitpointListPresenter(prisma14, prisma14, undefined, router).call({
        environment: env,
      });

      // The list render omits the token this pass (findManyWaitpoints), and the empty-state probe
      // reports hasAnyTokens=false (the #probeAnyToken findWaitpoint read, cosmetic copy). No write
      // gated; self-heals next fetch.
      expect(laggy.success).toBe(true);
      if (!laggy.success) throw new Error("unreachable");
      expect(laggy.tokens).toEqual([]);
      expect(laggy.hasAnyTokens).toBe(false);
      expect(legacyReplica.wasHit()).toBe(true);

      // Prove pure lag: the SAME presenter over a healthy router surfaces the live token.
      const healthy = await new WaitpointListPresenter(
        prisma14,
        prisma14,
        undefined,
        buildHealthyRouter(prisma14, prisma17).router
      ).call({ environment: env });
      expect(healthy.success).toBe(true);
      if (!healthy.success) throw new Error("unreachable");
      expect(healthy.tokens).toHaveLength(1);
      expect(healthy.tokens[0]!.id).toBe("waitpoint_list");
      expect(healthy.hasAnyTokens).toBe(true);
    }
  );

  // WaitpointPresenter findWaitpoint
  heteroRunOpsPostgresTest(
    "WaitpointPresenter.call returns null for a token detail under replica lag",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouter(prisma14, prisma17, {
        waitpoint: true,
      });
      const seed = await seedEnvironmentLegacy(prisma14, "detail");
      const friendlyId = "waitpoint_detail";
      await seedManualWaitpoint(legacyStore, {
        id: `waitpoint_${CUID_25}`,
        friendlyId,
        projectId: seed.project.id,
        environmentId: seed.environment.id,
      });
      holder.env = {
        id: seed.environment.id,
        organizationId: seed.organization.id,
        apiKey: seed.environment.apiKey,
      };

      const laggy = await new WaitpointPresenter(prisma14, prisma14, undefined, router).call({
        friendlyId,
        environmentId: seed.environment.id,
        projectId: seed.project.id,
      });

      // The detail loader returns null → not-found page → user reloads. No write.
      expect(laggy).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      const healthy = await new WaitpointPresenter(
        prisma14,
        prisma14,
        undefined,
        buildHealthyRouter(prisma14, prisma17).router
      ).call({ friendlyId, environmentId: seed.environment.id, projectId: seed.project.id });
      expect(healthy).not.toBeNull();
      expect(healthy!.id).toBe(friendlyId);
      expect(healthy!.type).toBe("MANUAL");
    }
  );

  // WaitpointPresenter findWaitpointConnectedRunIds
  heteroRunOpsPostgresTest(
    "WaitpointPresenter.call renders an empty connected-runs list when the connection join lags",
    async ({ prisma14, prisma17 }) => {
      // Freeze only the raw connection JOIN: the waitpoint read succeeds, so the caller reaches the
      // connection-id gather, which comes back empty under lag.
      const { router, legacyStore, legacyReplica } = buildRouter(prisma14, prisma17, { raw: true });
      const seed = await seedEnvironmentLegacy(prisma14, "conn68");
      const waitpointId = `waitpoint_${CUID_25}`;
      const runId = `run_${CUID_25}`; // cuid → LEGACY, co-located with the token
      const friendlyId = "waitpoint_conn68";
      await seedManualWaitpoint(legacyStore, {
        id: waitpointId,
        friendlyId,
        projectId: seed.project.id,
        environmentId: seed.environment.id,
      });
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: "run_conn68",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });
      await router.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [waitpointId],
        projectId: seed.project.id,
      });
      holder.env = {
        id: seed.environment.id,
        organizationId: seed.organization.id,
        apiKey: seed.environment.apiKey,
      };

      const laggy = await new WaitpointPresenter(prisma14, prisma14, undefined, router).call({
        friendlyId,
        environmentId: seed.environment.id,
        projectId: seed.project.id,
      });

      // The token detail renders (found via replica) but the connected-runs list is empty this pass —
      // display only, no decision on the stale set.
      expect(laggy).not.toBeNull();
      expect(laggy!.id).toBe(friendlyId);
      expect(laggy!.connectedRuns).toEqual([]);
      expect(legacyReplica.wasHit()).toBe(true);

      // Prove pure lag: over a healthy router the connection id is gathered.
      const healthyRouter = buildHealthyRouter(prisma14, prisma17).router;
      const connectedIds = await healthyRouter.findWaitpointConnectedRunIds(waitpointId);
      expect(connectedIds).toEqual([runId]);
    }
  );

  // WaitpointPresenter findRuns
  heteroRunOpsPostgresTest(
    "WaitpointPresenter.call leaves connected-runs empty when the run lookup lags",
    async ({ prisma14, prisma17 }) => {
      // Freeze only taskRun reads: the waitpoint read and the connection gather succeed, so the caller
      // reaches the friendlyId resolution, which comes back empty.
      const { router, legacyStore, legacyReplica } = buildRouter(prisma14, prisma17, {
        taskRun: true,
      });
      const seed = await seedEnvironmentLegacy(prisma14, "conn72");
      const waitpointId = `waitpoint_${CUID_25}`;
      const runId = `run_${CUID_25}`;
      const friendlyId = "waitpoint_conn72";
      await seedManualWaitpoint(legacyStore, {
        id: waitpointId,
        friendlyId,
        projectId: seed.project.id,
        environmentId: seed.environment.id,
      });
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: "run_conn72",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });
      await router.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [waitpointId],
        projectId: seed.project.id,
      });
      holder.env = {
        id: seed.environment.id,
        organizationId: seed.organization.id,
        apiKey: seed.environment.apiKey,
      };

      // Confirm this read is genuinely reached: the connection gather ran (raw NOT frozen); the taskRun
      // read is the one that lags.
      const connectedIds = await router.findWaitpointConnectedRunIds(waitpointId);
      expect(connectedIds).toEqual([runId]);

      const laggy = await new WaitpointPresenter(prisma14, prisma14, undefined, router).call({
        friendlyId,
        environmentId: seed.environment.id,
        projectId: seed.project.id,
      });

      // Connected-run friendlyId resolution missed under lag → connectedRuns empty this render;
      // display only.
      expect(laggy).not.toBeNull();
      expect(laggy!.connectedRuns).toEqual([]);
      expect(legacyReplica.wasHit()).toBe(true);

      // Prove pure lag: over a healthy router findRuns resolves the run's friendlyId.
      const healthyRouter = buildHealthyRouter(prisma14, prisma17).router;
      const runs = (await healthyRouter.findRuns({
        where: { id: { in: [runId] } },
        select: { friendlyId: true },
        take: 5,
      })) as Array<{ friendlyId: string }>;
      expect(runs).toHaveLength(1);
      expect(runs[0]!.friendlyId).toBe("run_conn72");
    }
  );

  // WaitpointTagListPresenter findManyWaitpointTags
  heteroRunOpsPostgresTest(
    "WaitpointTagListPresenter.call omits a just-created tag under replica lag",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouter(prisma14, prisma17, {
        waitpointTag: true,
      });
      const seed = await seedEnvironmentLegacy(prisma14, "tags");
      await legacyStore.upsertWaitpointTag({
        environmentId: seed.environment.id,
        name: "my-tag",
        projectId: seed.project.id,
      });

      const laggy = await new WaitpointTagListPresenter(prisma14, prisma14, undefined, router).call(
        { environmentId: seed.environment.id }
      );

      // The tag-filter dropdown omits the new tag this render; eventual-consistency list.
      expect(laggy.tags).toEqual([]);
      expect(legacyReplica.wasHit()).toBe(true);

      const healthy = await new WaitpointTagListPresenter(
        prisma14,
        prisma14,
        undefined,
        buildHealthyRouter(prisma14, prisma17).router
      ).call({ environmentId: seed.environment.id });
      expect(healthy.tags).toEqual([{ name: "my-tag" }]);
    }
  );
});
