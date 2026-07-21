// Property: the replay ACTION resolves a source run that exists only on the owning primary and REPLAYS
// it (findRun by friendlyId, re-read on `prisma` when the replica misses) rather than reporting "Run
// not found". Drives the REAL exported route `action` on a real split topology
// (heteroRunOpsPostgresTest) with the owning legacy replica FROZEN and an empty mollifier buffer, so
// the primary re-read is the only path that resolves the run. Only orthogonal deps are stubbed (the
// auth/RBAC wrapper, downstream ReplayTaskRunService.call, the mollifier buffer, redirect helpers).

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect, vi } from "vitest";

// ---- hoisted holders (vi.mock factories run before imports) ---------------------------------
const routerHolder = vi.hoisted(() => ({ router: undefined as any }));
const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));
const replayCallSpy = vi.hoisted(() => vi.fn());

// The route reads the source run through the `runStore` singleton. Point it at the split
// RoutingRunStore we build per-test (frozen legacy replica + real primary).
vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const router = routerHolder.router;
        if (!router) throw new Error("routerHolder.router not set for this test");
        const value = (router as any)[prop];
        return typeof value === "function" ? value.bind(router) : value;
      },
    }
  ),
}));

// The `prisma` singleton is the client the action passes as the primary re-read override, and the
// one controlPlaneResolver + the org-membership auth query read. Point every db.server handle at
// the real control-plane (PG14) container. The DB is never mocked — the proxy forwards to a real
// testcontainer client. (Re-resolving delegates per access mirrors waitpointCallback.controlPlane.)
vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  const lazyProxy = (holder: { client: any }, label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (!holder.client) throw new Error(`${label} not set for this test`);
          const value = holder.client[prop];
          if (value !== null && typeof value === "object") {
            return new Proxy(value, { get: (_d, method) => holder.client[prop][method] });
          }
          return value;
        },
      }
    );
  const cp = lazyProxy(primaryHolder, "primaryHolder.client");
  return {
    prisma: cp,
    $replica: cp,
    runOpsNewPrisma: cp,
    runOpsNewReplica: cp,
    runOpsLegacyPrisma: cp,
    runOpsLegacyReplica: cp,
    runOpsNewPrismaClient: cp,
    runOpsNewReplicaClient: cp,
    runOpsLegacyPrismaClient: cp,
    runOpsLegacyReplicaClient: cp,
    runOpsSplitReadEnabled: false,
    sqlDatabaseSchema: Prisma.sql([`public`]),
    Prisma,
  };
});

// Bypass ONLY the auth/RBAC wrapper — return the handler verbatim so the REAL action body runs.
vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardAction: (_options: unknown, handler: unknown) => handler,
  dashboardLoader: (_options: unknown, handler: unknown) => handler,
}));

// Downstream collaborator: observe whether the action reached the replay, without triggering one.
vi.mock("~/v3/services/replayTaskRun.server", () => ({
  ReplayTaskRunService: class {
    call = replayCallSpy;
  },
}));

// Force the mollifier buffer empty so the ONLY way pgRun resolves is the primary re-read.
vi.mock("~/v3/mollifier/mollifierBuffer.server", () => ({
  getMollifierBuffer: () => null,
}));

// Make the redirect helpers session-free so the returned Response is deterministic regardless of
// SESSION_SECRET; keep every other export real.
vi.mock("~/models/message.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    redirectWithSuccessMessage: (path: string) =>
      new Response(null, { status: 302, headers: { location: path } }),
    redirectWithErrorMessage: (path: string) =>
      new Response(null, { status: 302, headers: { location: path } }),
  };
});

import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import { action } from "~/routes/resources.taskruns.$runParam.replay";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CUID_25 = "c".repeat(25); // classifies LEGACY

let seedN = 0;
async function seedTenant(prisma: PrismaClient) {
  const suffix = `replay_guard_${seedN++}`;
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
  const user = await prisma.user.create({
    data: {
      email: `${suffix}@test.local`,
      authenticationMethod: "MAGIC_LINK",
      admin: false,
    },
  });
  // Org membership: the action's authorization query is
  //   project.findFirst({ where: { id, organization: { members: { some: { userId } } } } })
  await prisma.orgMember.create({
    data: { userId: user.id, organizationId: organization.id, role: "ADMIN" },
  });
  return { organization, project, environment, user };
}

function sourceRunData(opts: {
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

// LEGACY-owning router whose legacy replica is frozen; the NEW store is a real (empty) store so the
// on-miss fan-out to the other store's replica also misses. Mirrors the split topology db.server
// builds in production (buildRunStore split path).
function buildRouterWithFrozenLegacyReplica(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
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
  return { router, legacyReplica };
}

const FAILED_REDIRECT = "/failed-redirect-sentinel";

function replayRequest() {
  const body = new URLSearchParams({ failedRedirect: FAILED_REDIRECT });
  return new Request("http://localhost/replay", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("replay action resolves a source run under owning-replica lag via the primary re-read", () => {
  heteroRunOpsPostgresTest(
    "resolves a source run that exists only on the owning primary and replays it",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedTenant(prisma14 as unknown as PrismaClient);
      const runId = `run_${CUID_25}`;
      const friendlyId = "run_replay_guard";
      await (prisma14 as unknown as PrismaClient).taskRun.create({
        data: sourceRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });

      // Wire the singletons the mocked modules read.
      primaryHolder.client = prisma14;
      const { router, legacyReplica } = buildRouterWithFrozenLegacyReplica(
        prisma14 as unknown as PrismaClient,
        prisma17
      );
      routerHolder.router = router;
      replayCallSpy.mockReset();
      replayCallSpy.mockResolvedValue({
        id: "run_new_internal",
        friendlyId: "run_new_friendly",
        spanId: "span_new",
      });

      // Drive the REAL action handler (auth wrapper stubbed to a passthrough).
      const response = (await action({
        request: replayRequest(),
        params: { runParam: friendlyId },
        user: { id: seed.user.id },
      } as never)) as Response;

      // The frozen replica was consulted (proves we exercised the lag path, not a warm replica).
      expect(legacyReplica.wasHit()).toBe(true);

      // The primary re-read resolved the source run, so the action reached the replay with the correct
      // source run (a replica-only read would leave pgRun null and report "Run not found" instead).
      expect(replayCallSpy).toHaveBeenCalledTimes(1);
      expect(replayCallSpy.mock.calls[0][0]).toMatchObject({ friendlyId });

      // User-facing: a success redirect to the new run's path, NOT the failedRedirect sentinel.
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).not.toBe(FAILED_REDIRECT);
      expect(response.headers.get("location")).toContain("run_new_friendly");
    }
  );
});
