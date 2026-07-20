// Replica-lag proof for the "routes-run-get" reads — every run-GET read that RoutingRunStore serves
// from the OWNING store's REPLICA. This file imports and drives the REAL exported loaders/actions
// from the route modules, against a REAL split RoutingRunStore over two Postgres testcontainers with
// the owning (legacy) store's REPLICA FROZEN via the shared laggingReplica primitive. Only deps
// orthogonal to the read are mocked (auth/session, control-plane env resolution, redirect/toast
// formatting, downstream engine/clickhouse/event/presenter services); the run-store read path each
// case's decision hangs on is the genuine article.
//
// For every case, the concrete proof driven through the real caller is the CORRECT observable output
// under lag:
//   * frozen-STALE replica (the run WAS replicated but carries an out-of-date snapshot): the caller's
//     routing/redirect/auth/queue-key DECISION is driven only by IMMUTABLE fields (projectId,
//     runtimeEnvironmentId, spanId, traceId, organizationId, engine, queue, concurrencyKey, createdAt),
//     so the real caller returns the CORRECT redirect / 200 payload even off the lagging replica — the
//     only staleness is cosmetic (status/completedAt) which the UI self-heals on the next poll.
//   * frozen-MISSING replica + a documented recovery: logs.$logId returns 200 with runStatus undefined
//     (optional annotation); the finished-attempt read returns null → empty output on a run that still
//     renders; the cancel/replay action context-resolvers fall back to the owning PRIMARY and resolve
//     the org (proven by the action NOT spuriously denying).
// The run-store read really goes through the frozen replica in each case — asserted with
// `wasHit("taskRun")` — so no proof is a lucky primary hit.

import { describe, expect, vi } from "vitest";
import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ── Hoisted holders wired per-test before each real caller runs ───────────────────────────────────
// `cp.client` -> the real control-plane container (prisma14): backs the mocked ~/db.server `prisma`
//   AND (branded) `$replica`, used for the orthogonal project/orgMember auth reads.
// `router.store` -> the real split RoutingRunStore whose legacy replica is frozen.
// `authUser`, `resolvedEnv`, `logDetail`, `project`, `environment` feed the mocked fix-orthogonal deps.
const cp = vi.hoisted(() => ({ client: undefined as any }));
const router = vi.hoisted(() => ({ store: undefined as any }));
const authUser = vi.hoisted(() => ({ id: "user_rrg_guard", admin: false, isImpersonating: false }));
const resolved = vi.hoisted(() => ({
  authEnv: undefined as any,
  env: undefined as any,
  lockedWorker: null as any,
}));
const logDetail = vi.hoisted(() => ({ result: undefined as any }));
const cpLookups = vi.hoisted(() => ({ project: undefined as any, environment: undefined as any }));
const cancelCalls = vi.hoisted(() => ({ runs: [] as any[] }));
const replayCalls = vi.hoisted(() => ({ runs: [] as any[] }));

const READ_REPLICA_BRAND = Symbol.for("trigger.dev/run-store/read-replica");

// ~/db.server: `prisma` -> real writer; `$replica` -> a BRANDED proxy over the real writer. The brand
// makes RoutingRunStore treat a `$replica`-arg read as a replica read (no primary escalation) exactly
// as production does, while property access (project/orgMember/taskSchedule.findFirst) forwards to the
// real control-plane client so the orthogonal auth reads work. Run-ops split handles are left
// undefined; the router is injected directly via the ~/v3/runStore.server mock below.
vi.mock("~/db.server", () => {
  const brandedReplica = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === READ_REPLICA_BRAND) return true;
        const c = cp.client;
        if (!c) throw new Error("cp.client not set for this test");
        const value = c[prop];
        return typeof value === "function" ? value.bind(c) : value;
      },
    }
  );
  const prismaProxy = new Proxy(
    {},
    {
      get(_t, prop) {
        const c = cp.client;
        if (!c) throw new Error("cp.client not set for this test");
        const value = c[prop];
        return typeof value === "function" ? value.bind(c) : value;
      },
    }
  );
  return {
    prisma: prismaProxy,
    $replica: brandedReplica,
    runOpsNewPrismaClient: undefined,
    runOpsNewReplicaClient: undefined,
    runOpsLegacyPrisma: undefined,
    runOpsLegacyReplica: undefined,
  };
});

// Inject the REAL split router. A stable Proxy keeps the named import binding constant while
// forwarding every method to the per-test router in `router.store`.
vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const store = router.store;
        if (!store) throw new Error("router.store not set for this test");
        const value = store[prop];
        return typeof value === "function" ? value.bind(store) : value;
      },
    }
  ),
}));

// Auth/session (orthogonal): fixed user id.
vi.mock("~/services/session.server", () => ({
  requireUserId: async () => authUser.id,
  requireUser: async () => authUser,
  getUserId: async () => authUser.id,
}));

// Control-plane env resolution (a downstream cross-DB lookup, orthogonal to the run-store read):
// returns whatever the test staged.
vi.mock("~/v3/runOpsMigration/controlPlaneResolver.server", () => ({
  controlPlaneResolver: {
    resolveAuthenticatedEnv: async () => resolved.authEnv,
    resolveEnv: async () => resolved.env,
    resolveRunLockedWorker: async () => resolved.lockedWorker,
  },
}));

// Redirect/toast formatting (orthogonal): marker Responses so assertions don't need cookie machinery.
vi.mock("~/models/message.server", () => ({
  redirectWithSuccessMessage: async (path: string, _req: Request, message: string) =>
    new Response(null, { status: 302, headers: { "x-redirect": path, "x-toast": message } }),
  redirectWithErrorMessage: async (path: string, _req: Request, message: string) =>
    new Response(null, { status: 302, headers: { "x-redirect": path, "x-error": message } }),
}));

// Buffer disabled everywhere so a run-store miss is a clean miss (no buffer masking the read outcome).
vi.mock("~/v3/mollifier/mollifierBuffer.server", () => ({ getMollifierBuffer: () => null }));

// debug-loader downstream: the run-queue Redis introspection is not the read under test.
vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    runQueue: {
      getQueueConcurrencyLimit: async () => 10,
      getEnvConcurrencyLimit: async () => 20,
      currentConcurrencyOfQueue: async () => 1,
      currentConcurrencyOfEnvironment: async () => 2,
      keys: {
        queueCurrentConcurrencyKey: () => "qcc",
        envCurrentConcurrencyKey: () => "ecc",
        queueConcurrencyLimitKey: () => "qcl",
        envConcurrencyLimitKey: () => "ecl",
      },
    },
  },
}));

// logs.$logId downstream: ClickHouse + presenter + slug lookups are orthogonal.
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => ({}) },
}));
vi.mock("~/presenters/v3/LogDetailPresenter.server", () => ({
  LogDetailPresenter: class {
    async call() {
      return logDetail.result;
    }
  },
}));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => cpLookups.project,
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => cpLookups.environment,
  displayableEnvironment: (env: any) => ({ id: env.id, type: env.type, slug: env.slug }),
}));

// logs.download downstream: event repository + trace export are orthogonal.
vi.mock("~/v3/eventRepository/index.server", () => ({
  getEventRepositoryForStore: async () => ({
    streamTraceEvents: async function* () {
      yield {} as any;
    },
  }),
}));
vi.mock("~/v3/eventRepository/traceExport.server", () => ({
  getTraceExportFormat: () => ({ extension: "log" }),
  streamTraceExport: async function* () {
    yield "trace-line\n";
  },
}));
vi.mock("~/v3/taskEventStore.server", () => ({
  getTaskEventStoreTableForRun: () => "taskEvent",
}));
vi.mock("~/env.server", () => ({
  env: { APP_ORIGIN: "https://app.test", TASK_RUN_METADATA_MAXIMUM_SIZE: 262144 },
}));

// replay-loader downstream: regions/worker/queue lookups are orthogonal.
vi.mock("~/presenters/v3/RegionsPresenter.server", () => ({
  RegionsPresenter: class {
    async call() {
      return { regions: [] };
    }
  },
}));
vi.mock("~/v3/models/workerDeployment.server", () => ({
  findCurrentWorkerDeployment: async () => null,
}));
vi.mock("~/runEngine/concerns/workerQueueSplit.server", () => ({
  regionForDisplay: () => undefined,
}));

// Downstream cancel/replay services (engine work, orthogonal): record the call.
vi.mock("~/v3/services/cancelTaskRun.server", () => ({
  CancelTaskRunService: class {
    async call(run: any) {
      cancelCalls.runs.push(run);
    }
  },
}));
vi.mock("~/v3/services/replayTaskRun.server", () => ({
  ReplayTaskRunService: class {
    async call(run: any) {
      replayCalls.runs.push(run);
      return { id: "new_run", friendlyId: "run_replayed", spanId: "span_new" };
    }
  },
}));

// RBAC gate (orthogonal) for the dashboardAction routes (cancel/replay). Passing ability; the route's
// own control-plane membership check still runs against seeded data.
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateSession: async () => ({
      ok: true,
      user: { id: authUser.id, email: "guard@example.com", admin: false },
      ability: { can: () => true, canSuper: () => true },
    }),
  },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Real callers under guard ──────────────────────────────────────────────────────────────────────
import { loader as orgsRedirectLoader } from "~/routes/orgs.$organizationSlug.projects.$projectParam.runs.$runParam";
import { loader as shortLinkLoader } from "~/routes/runs.$runParam";
import { loader as inspectorLoader } from "~/routes/resources.runs.$runParam";
import { loader as debugLoader } from "~/routes/resources.taskruns.$runParam.debug";
import { loader as logDetailLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.logs.$logId";
import { loader as logsDownloadLoader } from "~/routes/resources.runs.$runParam.logs.download";
import {
  loader as replayLoader,
  action as replayAction,
} from "~/routes/resources.taskruns.$runParam.replay";
import { action as cancelAction } from "~/routes/resources.taskruns.$runParam.cancel";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// A cuid-shaped id (25 chars, no run-ops marker) classifies LEGACY → friendlyId-keyed reads route to
// the legacy (control-plane / prisma14) store, whose replica we freeze.
const CUID_25 = "e".repeat(25);
let seq = 0;

async function seedTenant(prisma: PrismaClient, suffix: string) {
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
  await prisma.user.create({
    data: {
      id: authUser.id,
      email: `guard-${suffix}@example.com`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
  const orgMember = await prisma.orgMember.create({
    data: { userId: authUser.id, organizationId: organization.id, role: "ADMIN" },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      // Link the dev env to the org member so the replay loader's DEVELOPMENT env-list query
      // (orgMember.userId === userId) surfaces it.
      orgMemberId: orgMember.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { organization, project, environment };
}

function buildCreateRunInput(p: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  status?: string;
  spanId?: string;
  traceId?: string;
  createdAt?: Date;
  completedAt?: Date | null;
  concurrencyKey?: string | null;
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: (p.status ?? "PENDING") as never,
      friendlyId: p.friendlyId,
      runtimeEnvironmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: p.organizationId,
      projectId: p.projectId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: p.traceId ?? (p.spanId ? `trace_${p.friendlyId}` : "trace_1"),
      spanId: p.spanId ?? "span_1",
      runTags: [],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      concurrencyKey: p.concurrencyKey ?? undefined,
      createdAt: p.createdAt ?? new Date("2024-01-01T00:00:00.000Z"),
      completedAt: p.completedAt ?? undefined,
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: (p.status ?? "PENDING") as never,
      environmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: p.projectId,
      organizationId: p.organizationId,
    },
  };
}

// Build the router as runStore.server holds it: legacy store (prisma14) + dedicated store (prisma17).
// The legacy replica is a frozen laggingReplica; a friendlyId/cuid-routed read is served stale/missing.
function buildRouterWithFrozenLegacyReplica(
  prisma14: PrismaClient,
  prisma17: RunOpsPrismaClient,
  legacyReplica: AnyClient
) {
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: legacyReplica as never,
    schemaVariant: "legacy",
  });
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

function authEnvFor(seed: { organization: any; project: any; environment: any }) {
  return {
    id: seed.environment.id,
    slug: seed.environment.slug,
    type: seed.environment.type,
    apiKey: seed.environment.apiKey,
    organizationId: seed.organization.id,
    organization: {
      id: seed.organization.id,
      slug: seed.organization.slug,
      title: seed.organization.title,
    },
    project: {
      id: seed.project.id,
      slug: seed.project.slug,
      name: seed.project.name,
      externalRef: seed.project.externalRef,
    },
    git: null,
  };
}

describe("routes-run-get — REAL loaders/actions vs a frozen owning replica", () => {
  // orgs redirect loader — canonical run redirect
  heteroRunOpsPostgresTest(
    "orgs redirect loader: frozen-STALE replica → 302 to the correct v3 path (immutable projectId/runtimeEnvironmentId); frozen-MISSING → transient 404",
    async ({ prisma14, prisma17 }) => {
      const suffix = `rrg1_${seq++}`;
      cp.client = prisma14;
      const seed = await seedTenant(prisma14 as unknown as PrismaClient, suffix);
      const friendlyId = `run_${suffix}`;
      const runId = `run_${CUID_25}`;
      const writer = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      await writer.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "EXECUTING",
        })
      );
      resolved.authEnv = authEnvFor(seed);

      const req = (fid: string) =>
        new Request(
          `http://localhost/orgs/${seed.organization.slug}/projects/${seed.project.slug}/runs/${fid}`
        );
      const params = (fid: string) => ({
        organizationSlug: seed.organization.slug,
        projectParam: seed.project.slug,
        runParam: fid,
      });

      // (a) frozen-STALE: the run IS on the replica but with an out-of-date snapshot. projectId +
      // runtimeEnvironmentId are immutable, so the redirect target is correct off the lagging replica.
      const stale = laggingReplica(prisma14, [
        {
          model: "taskRun",
          mode: "frozen",
          rows: [
            {
              friendlyId,
              projectId: seed.project.id,
              runtimeEnvironmentId: seed.environment.id,
              status: "PENDING",
            },
          ],
        },
      ]);
      router.store = buildRouterWithFrozenLegacyReplica(
        prisma14 as any,
        prisma17 as any,
        stale.client
      );
      const staleRes = (await orgsRedirectLoader({
        request: req(friendlyId),
        params: params(friendlyId),
        context: {} as never,
      })) as Response;
      expect(stale.wasHit("taskRun")).toBe(true);
      expect(staleRes.status).toBe(302);
      expect(staleRes.headers.get("location")).toBe(
        `/orgs/${seed.organization.slug}/projects/${seed.project.slug}/env/${seed.environment.slug}/runs/${friendlyId}`
      );

      // (b) frozen-MISSING: transient not-found (drives no mutation; self-heals on next load).
      const missing = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      router.store = buildRouterWithFrozenLegacyReplica(
        prisma14 as any,
        prisma17 as any,
        missing.client
      );
      let missStatus = 0;
      try {
        await orgsRedirectLoader({
          request: req(friendlyId),
          params: params(friendlyId),
          context: {} as never,
        });
      } catch (e) {
        missStatus = (e as Response).status;
      }
      expect(missing.wasHit("taskRun")).toBe(true);
      expect(missStatus).toBe(404);
    }
  );

  // short-link loader — public short-link redirect
  heteroRunOpsPostgresTest(
    "short-link loader: frozen-STALE → 302 to correct v3 path with ?span (immutable spanId/projectId); frozen-MISSING → error-redirect (no crash)",
    async ({ prisma14, prisma17 }) => {
      const suffix = `rrg2_${seq++}`;
      cp.client = prisma14;
      const seed = await seedTenant(prisma14 as unknown as PrismaClient, suffix);
      const friendlyId = `run_${suffix}`;
      const runId = `run_${CUID_25}`;
      const spanId = "span_short_fixed";
      const writer = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      await writer.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "EXECUTING",
          spanId,
        })
      );
      resolved.authEnv = authEnvFor(seed);

      const stale = laggingReplica(prisma14, [
        {
          model: "taskRun",
          mode: "frozen",
          rows: [
            {
              friendlyId,
              spanId,
              projectId: seed.project.id,
              runtimeEnvironmentId: seed.environment.id,
            },
          ],
        },
      ]);
      router.store = buildRouterWithFrozenLegacyReplica(
        prisma14 as any,
        prisma17 as any,
        stale.client
      );
      const staleRes = (await shortLinkLoader({
        request: new Request(`http://localhost/runs/${friendlyId}`),
        params: { runParam: friendlyId },
        context: {} as never,
      })) as Response;
      expect(stale.wasHit("taskRun")).toBe(true);
      expect(staleRes.status).toBe(302);
      const loc = staleRes.headers.get("location")!;
      expect(loc).toContain(
        `/orgs/${seed.organization.slug}/projects/${seed.project.slug}/env/${seed.environment.slug}/runs/${friendlyId}`
      );
      expect(loc).toContain(`span=${spanId}`);

      // frozen-MISSING → the loader returns the error-redirect marker (302, x-error), never throws/500.
      const missing = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      router.store = buildRouterWithFrozenLegacyReplica(
        prisma14 as any,
        prisma17 as any,
        missing.client
      );
      const missRes = (await shortLinkLoader({
        request: new Request(`http://localhost/runs/${friendlyId}`),
        params: { runParam: friendlyId },
        context: {} as never,
      })) as Response;
      expect(missing.wasHit("taskRun")).toBe(true);
      expect(missRes.status).toBe(302);
      expect(missRes.headers.get("x-error")).toContain("doesn't exist");
    }
  );

  // inspector loader — findRun + the finished-attempt read
  heteroRunOpsPostgresTest(
    "inspector loader: frozen-STALE run → 200 typedjson with correct immutable friendlyId; the finished-attempt read missing on the replica → empty output, run still renders",
    async ({ prisma14, prisma17 }) => {
      const suffix = `rrg3_${seq++}`;
      cp.client = prisma14;
      const seed = await seedTenant(prisma14 as unknown as PrismaClient, suffix);
      const friendlyId = `run_${suffix}`;
      const runId = `run_${CUID_25}`;
      const createdAt = new Date("2024-02-02T00:00:00.000Z");
      const writer = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      await writer.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "COMPLETED_SUCCESSFULLY",
          createdAt,
        })
      );
      resolved.authEnv = authEnvFor(seed);
      resolved.lockedWorker = null;

      // Stale run row (immutable id/projectId/createdAt/friendlyId correct) AND the finished-attempt
      // read misses on the replica → output undefined, but the run still renders 200.
      const stale = laggingReplica(prisma14, [
        {
          model: "taskRun",
          mode: "frozen",
          rows: [
            {
              id: runId,
              friendlyId,
              status: "COMPLETED_SUCCESSFULLY",
              projectId: seed.project.id,
              runtimeEnvironmentId: seed.environment.id,
              createdAt,
              queue: "task/my-task",
              payload: '{"hello":"world"}',
              payloadType: "application/json",
              runTags: [],
              baseCostInCents: 0,
              costInCents: 0,
            },
          ],
        },
        { model: "taskRunAttempt", mode: "missing" },
      ]);
      router.store = buildRouterWithFrozenLegacyReplica(
        prisma14 as any,
        prisma17 as any,
        stale.client
      );
      const res = (await inspectorLoader({
        request: new Request(`http://localhost/resources/runs/${friendlyId}`),
        params: { runParam: friendlyId },
        context: {} as never,
      })) as Response;
      expect(stale.wasHit("taskRun")).toBe(true);
      expect(stale.wasHit("taskRunAttempt")).toBe(true); // the finished-attempt read hit the replica
      expect(res.status).toBe(200);
      const body = await res.json();
      // typedjson envelope: payload is under .json in remix-typedjson serialisation
      const data = body.json ?? body;
      expect(data.friendlyId).toBe(friendlyId);
      expect(data.isFinished).toBe(true);
      // finished-attempt read missed on the replica → output absent (typedjson encodes the
      // undefined as null over the wire), but the run itself rendered.
      expect(data.output ?? null).toBeNull();
    }
  );

  // debug loader — admin queue-debug
  heteroRunOpsPostgresTest(
    "debug loader: frozen-STALE → 200 with the run + queue keys derived from immutable engine/queue/concurrencyKey",
    async ({ prisma14, prisma17 }) => {
      const suffix = `rrg4_${seq++}`;
      cp.client = prisma14;
      const seed = await seedTenant(prisma14 as unknown as PrismaClient, suffix);
      const friendlyId = `run_${suffix}`;
      const runId = `run_${CUID_25}`;
      const writer = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      await writer.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "EXECUTING",
          concurrencyKey: "ck-site4",
        })
      );
      resolved.authEnv = authEnvFor(seed);

      const stale = laggingReplica(prisma14, [
        {
          model: "taskRun",
          mode: "frozen",
          rows: [
            {
              id: runId,
              friendlyId,
              engine: "V2",
              queue: "task/my-task",
              concurrencyKey: "ck-site4",
              queueTimestamp: null,
              runtimeEnvironmentId: seed.environment.id,
              projectId: seed.project.id,
            },
          ],
        },
      ]);
      router.store = buildRouterWithFrozenLegacyReplica(
        prisma14 as any,
        prisma17 as any,
        stale.client
      );
      const res = (await debugLoader({
        request: new Request(`http://localhost/resources/taskruns/${friendlyId}/debug`),
        params: { runParam: friendlyId },
        context: {} as never,
      })) as Response;
      expect(stale.wasHit("taskRun")).toBe(true);
      expect(res.status).toBe(200);
      const body = await res.json();
      const data = body.json ?? body;
      expect(data.engine).toBe("V2");
      expect(data.run.queue).toBe("task/my-task");
      expect(data.run.concurrencyKey).toBe("ck-site4");
    }
  );

  // log-detail loader — run-status annotation (branded $replica)
  heteroRunOpsPostgresTest(
    "log-detail loader: findRun($replica-branded) MISSING on the replica → 200 with runStatus undefined (optional annotation self-heals)",
    async ({ prisma14, prisma17 }) => {
      const suffix = `rrg5_${seq++}`;
      cp.client = prisma14;
      const seed = await seedTenant(prisma14 as unknown as PrismaClient, suffix);
      const friendlyId = `run_${suffix}`;
      const runId = `run_${CUID_25}`;
      const writer = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      await writer.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "COMPLETED_SUCCESSFULLY",
        })
      );
      cpLookups.project = { id: seed.project.id, organizationId: seed.organization.id };
      cpLookups.environment = { id: seed.environment.id, type: "DEVELOPMENT", slug: "dev" };
      logDetail.result = { runId: friendlyId, message: "hello", someField: 1 };

      const missing = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      router.store = buildRouterWithFrozenLegacyReplica(
        prisma14 as any,
        prisma17 as any,
        missing.client
      );

      const logId = encodeURIComponent(`trace_x::span_x::${friendlyId}::2024-01-01T00:00:00.000Z`);
      const res = (await logDetailLoader({
        request: new Request(`http://localhost/resources/orgs/o/projects/p/env/dev/logs/${logId}`),
        params: {
          organizationSlug: seed.organization.slug,
          projectParam: seed.project.slug,
          envParam: "dev",
          logId,
        },
        context: {} as never,
      })) as Response;
      expect(missing.wasHit("taskRun")).toBe(true);
      expect(res.status).toBe(200);
      const body = await res.json();
      const data = body.json ?? body;
      // The log detail is returned; the run-status annotation the lagging replica couldn't supply is
      // simply undefined (the caller optional-chains `run?.status`).
      expect(data.message).toBe("hello");
      expect(data.runStatus ?? null).toBeNull();
    }
  );

  // trace-download loader — trace-export download
  heteroRunOpsPostgresTest(
    "trace-download loader: frozen-STALE (completedAt null) → 200 gzip stream; immutable traceId/org/createdAt drive the export window, stale-null completedAt = open-ended (superset) not lossy",
    async ({ prisma14, prisma17 }) => {
      const suffix = `rrg6_${seq++}`;
      cp.client = prisma14;
      const seed = await seedTenant(prisma14 as unknown as PrismaClient, suffix);
      const friendlyId = `run_${suffix}`;
      const runId = `run_${CUID_25}`;
      const traceId = "trace_dl_fixed";
      const createdAt = new Date("2024-03-03T00:00:00.000Z");
      const writer = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      await writer.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "COMPLETED_SUCCESSFULLY",
          traceId,
          createdAt,
          completedAt: new Date("2024-03-03T00:05:00.000Z"),
        })
      );
      resolved.authEnv = authEnvFor(seed);

      const stale = laggingReplica(prisma14, [
        {
          model: "taskRun",
          mode: "frozen",
          rows: [
            {
              friendlyId,
              traceId,
              organizationId: seed.organization.id,
              runtimeEnvironmentId: seed.environment.id,
              createdAt,
              completedAt: null,
              taskEventStore: "taskEvent",
              taskIdentifier: "my-task",
            },
          ],
        },
      ]);
      router.store = buildRouterWithFrozenLegacyReplica(
        prisma14 as any,
        prisma17 as any,
        stale.client
      );
      const res = (await logsDownloadLoader({
        request: new Request(`http://localhost/resources/runs/${friendlyId}/logs/download`),
        params: { runParam: friendlyId },
        context: {} as never,
      })) as Response;
      expect(stale.wasHit("taskRun")).toBe(true);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Encoding")).toBe("gzip");
      expect(res.headers.get("Content-Disposition")).toContain(`${friendlyId}.log`);
    }
  );

  // replay loader — replay dialog
  heteroRunOpsPostgresTest(
    "replay loader: frozen-STALE run → 200 typedjson replay payload built from immutable seed fields (payload/tags/queue)",
    async ({ prisma14, prisma17 }) => {
      const suffix = `rrg8_${seq++}`;
      cp.client = prisma14;
      const seed = await seedTenant(prisma14 as unknown as PrismaClient, suffix);
      const friendlyId = `run_${suffix}`;
      const runId = `run_${CUID_25}`;
      // Seed a project row the replay loader's loadProjectEnvironments ($replica.project.findFirst) finds
      // with an environment matching runtimeEnvironmentId.
      const writer = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      await writer.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "COMPLETED_SUCCESSFULLY",
        })
      );

      const stale = laggingReplica(prisma14, [
        {
          model: "taskRun",
          mode: "frozen",
          rows: [
            {
              friendlyId,
              payload: '{"hello":"world"}',
              payloadType: "application/json",
              seedMetadata: null,
              seedMetadataType: null,
              runtimeEnvironmentId: seed.environment.id,
              projectId: seed.project.id,
              concurrencyKey: null,
              maxAttempts: null,
              maxDurationInSeconds: null,
              machinePreset: null,
              workerQueue: null,
              region: null,
              ttl: null,
              idempotencyKey: null,
              runTags: [],
              queue: "task/my-task",
              taskIdentifier: "my-task",
            },
          ],
        },
      ]);
      router.store = buildRouterWithFrozenLegacyReplica(
        prisma14 as any,
        prisma17 as any,
        stale.client
      );
      const res = (await replayLoader({
        request: new Request(`http://localhost/resources/taskruns/${friendlyId}/replay`),
        params: { runParam: friendlyId },
        context: {} as never,
      })) as Response;
      expect(stale.wasHit("taskRun")).toBe(true);
      expect(res.status).toBe(200);
      const body = await res.json();
      const data = body.json ?? body;
      expect(data.queue).toBe("task/my-task");
      expect(data.runTags).toEqual([]);
    }
  );

  // cancel action — resolveRunOrganizationId (dashboardAction)
  // The action's `context` resolver reads the run by friendlyId (client-less → REPLICA) to resolve
  // the org that scopes the RBAC check. Under a frozen-MISSING replica (+ drained buffer) the first
  // read misses and the PRIMARY FALLBACK re-reads the owning primary to recover the org. This is
  // load-bearing: authenticateAndAuthorize denies a scoped action when `ctx.organizationId` is absent
  // (hasScope=false → fail-closed). Driving the REAL action under lag returns the 302 success
  // redirect and reaches the cancel, reachable only if the fallback resolved the org.
  heteroRunOpsPostgresTest(
    "cancel action ctx resolver: frozen-MISSING replica → primary fallback resolves the org → action authorizes and cancels (not fail-closed 403)",
    async ({ prisma14, prisma17 }) => {
      const suffix = `rrg7_${seq++}`;
      cp.client = prisma14;
      const seed = await seedTenant(prisma14 as unknown as PrismaClient, suffix);
      const friendlyId = `run_${suffix}`;
      const runId = `run_${CUID_25}`;
      const writer = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      await writer.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "EXECUTING",
        })
      );
      // The context resolver's resolveEnv (mocked control-plane) returns the org for the primary-found run.
      resolved.env = { organizationId: seed.organization.id };
      cancelCalls.runs.length = 0;

      const missing = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      router.store = buildRouterWithFrozenLegacyReplica(
        prisma14 as any,
        prisma17 as any,
        missing.client
      );

      const redirectUrl = `/orgs/${seed.organization.slug}/projects/${seed.project.slug}/runs`;
      const res = (await cancelAction({
        request: new Request(`http://localhost/resources/taskruns/${friendlyId}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ redirectUrl }).toString(),
        }),
        params: { runParam: friendlyId },
        context: {} as never,
      })) as Response;

      expect(missing.wasHit("taskRun")).toBe(true);
      // Authorized + cancelled — impossible unless the ctx resolver recovered the org via the primary
      // fallback (a missing scope would have failed authorization closed with a redirect/403).
      expect(res.status).toBe(302);
      expect(res.headers.get("x-toast")).toBe("Canceled run");
      expect(cancelCalls.runs).toHaveLength(1);
      expect(cancelCalls.runs[0].friendlyId).toBe(friendlyId);
    }
  );

  // replay action — resolveRunOrganizationId (dashboardAction)
  // Identical shape to the cancel action above: the ctx resolver's client-less findRun misses the
  // frozen replica, the PRIMARY FALLBACK recovers the org, and the scoped RBAC check therefore
  // authorizes. The REAL replay action under lag returns the 302 success redirect and reaches the
  // replay service (only reachable with a resolved org scope).
  heteroRunOpsPostgresTest(
    "replay action ctx resolver: frozen-MISSING replica → primary fallback resolves the org → action authorizes and replays (not fail-closed 403)",
    async ({ prisma14, prisma17 }) => {
      const suffix = `rrg8b_${seq++}`;
      cp.client = prisma14;
      const seed = await seedTenant(prisma14 as unknown as PrismaClient, suffix);
      const friendlyId = `run_${suffix}`;
      const runId = `run_${CUID_25}`;
      const writer = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      await writer.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "COMPLETED_SUCCESSFULLY",
        })
      );
      resolved.env = { organizationId: seed.organization.id };
      resolved.authEnv = authEnvFor(seed);
      replayCalls.runs.length = 0;

      const missing = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      router.store = buildRouterWithFrozenLegacyReplica(
        prisma14 as any,
        prisma17 as any,
        missing.client
      );

      const failedRedirect = `/orgs/${seed.organization.slug}/projects/${seed.project.slug}/runs/${friendlyId}`;
      const res = (await replayAction({
        request: new Request(`http://localhost/resources/taskruns/${friendlyId}/replay`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ failedRedirect }).toString(),
        }),
        params: { runParam: friendlyId },
        context: {} as never,
      })) as Response;

      expect(missing.wasHit("taskRun")).toBe(true);
      expect(res.status).toBe(302);
      expect(res.headers.get("x-toast")).toBe("Replaying run");
      expect(replayCalls.runs).toHaveLength(1);
      expect(replayCalls.runs[0].friendlyId).toBe(friendlyId);
    }
  );
});
