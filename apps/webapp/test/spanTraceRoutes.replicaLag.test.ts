// Replica-lag properties for the run-trace / span-detail reads, each driven through its REAL exported
// route caller (never a reimplemented read) against a real split Postgres with the owning LEGACY replica
// FROZEN via laggingReplica. The routes pass a branded $replica, so reads stay on the owning replica.
// Only orthogonal webapp singletons are mocked (bearer auth, mollifier buffer, ClickHouse repository,
// formatters, session cookie, control-plane resolver, longPollingFetch).
//
// Properties per read: the spans/trace findResource reads emit a RETRYABLE 404 (x-should-retry:true) on a
// replica+buffer miss and return 200 once the replica catches up (proven with a caught-up store); the
// triggeredRuns list simply omits a just-triggered child under lag (200, eventually consistent); the sync
// trace-runs loader recovers a live run via a primary re-read on a replica miss and still 404s a truly-absent run.

import { describe, expect, vi } from "vitest";
import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ---- Hoisted holders wired into the mocked module singletons before each loader call. -------------
// The branded `$replica` marker uses the global-registry symbol the run-store brands replicas with
// (readReplicaClient.ts) so the routing store keeps the read on the owning REPLICA. It also carries a
// live `orgMember` delegate (pointed at the real prisma14) because the sync route reads
// `$replica.orgMember.findFirst` directly — orthogonal to the run read under test.
const { holder } = vi.hoisted(() => {
  const REPLICA_BRAND = Symbol.for("trigger.dev/run-store/read-replica");
  return {
    holder: {
      REPLICA_BRAND,
      store: undefined as unknown,
      replicaMarker: undefined as unknown,
      environment: undefined as unknown,
      bufferResult: null as unknown,
      userId: undefined as unknown,
      resolvedEnv: undefined as unknown,
      span: undefined as unknown,
      traceSummary: undefined as unknown,
    },
  };
});

// Run-store singleton: a stable Proxy forwarding every method to the per-test RoutingRunStore.
vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const store = holder.store as Record<string | symbol, unknown>;
        if (!store) throw new Error("test bug: holder.store not initialised before loader ran");
        const value = store[prop];
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(store)
          : value;
      },
    }
  ),
}));

// `$replica` brand marker (routes it to the owning replica) + a live orgMember delegate for the sync route.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === holder.REPLICA_BRAND) return true;
        const marker = holder.replicaMarker as Record<string | symbol, unknown> | undefined;
        return marker ? marker[prop] : undefined;
      },
    }
  ),
}));

// Bearer auth + ability (orthogonal): resolve to the seeded environment and grant every check.
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateBearer: async () => ({
      ok: true,
      environment: holder.environment,
      subject: { type: "privateKey" },
      jwt: undefined,
      ability: { can: () => true, canSuper: () => true },
    }),
  },
}));

// Buffer fallback (mollifier): a clean MISS so the only run source is the run-store read path.
vi.mock("~/v3/mollifier/readFallback.server", () => ({
  findRunByIdWithMollifierFallback: vi.fn(async () => holder.bufferResult),
}));

// ClickHouse event repository (downstream, orthogonal): return synthetic span / trace shapes.
vi.mock("~/v3/eventRepository/index.server", () => ({
  getEventRepositoryForStore: async () => ({
    getSpan: async () => holder.span,
    getTraceDetailedSubtreeSummary: async () => holder.traceSummary,
  }),
}));
vi.mock("~/v3/taskEventStore.server", () => ({
  getTaskEventStoreTableForRun: () => "taskEvent",
}));
vi.mock("~/components/runs/v3/ai", () => ({
  extractAISpanData: () => undefined,
}));
vi.mock("~/v3/mollifier/syntheticApiResponses.server", () => ({
  buildSyntheticSpanDetailBody: (r: unknown) => ({ synthetic: true, run: r }),
  buildSyntheticTraceBody: (r: unknown) => ({ synthetic: true, run: r }),
}));

// Sync-route peripherals (orthogonal to the run read under test).
vi.mock("~/services/session.server", () => ({
  getUserId: async () => holder.userId,
}));
vi.mock("~/v3/runOpsMigration/controlPlaneResolver.server", () => ({
  controlPlaneResolver: { resolveEnv: async () => holder.resolvedEnv },
}));
vi.mock("~/utils/longPollingFetch", () => ({
  longPollingFetch: async () =>
    new Response("shape-stream-ok", { status: 200, headers: { "x-longpoll": "hit" } }),
}));
// Ensure ELECTRIC_ORIGIN is defined for the sync route's happy path; keep every other env value real
// so the heavy apiBuilder import graph still loads.
vi.mock("~/env.server", async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> };
  return { env: { ...actual.env, ELECTRIC_ORIGIN: "http://electric.test" } };
});

import { loader as spansLoader } from "~/routes/api.v1.runs.$runId.spans.$spanId";
import { loader as traceLoader } from "~/routes/api.v1.runs.$runId.trace";
import { loader as syncTraceRunsLoader } from "~/routes/sync.traces.runs.$traceId";

// A cuid (25 chars after `run_`) classifies LEGACY, so both the create and the friendlyId/traceId
// reads route to the legacy (control-plane) store — the store that owns these runs.
const CUID_25 = "c".repeat(25);
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

// The AuthenticatedEnvironment shape the real wrapper + handlers read.
function authEnvironment(seed: Awaited<ReturnType<typeof seedTenant>>) {
  return {
    id: seed.environment.id,
    apiKey: seed.environment.apiKey,
    type: "DEVELOPMENT",
    slug: "dev",
    organizationId: seed.organization.id,
    organization: { id: seed.organization.id, slug: seed.organization.slug },
    project: {
      id: seed.project.id,
      slug: seed.project.slug,
      externalRef: seed.project.externalRef,
    },
  };
}

function buildCreateRunInput(p: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  taskIdentifier?: string;
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: p.friendlyId,
      runtimeEnvironmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: p.organizationId,
      projectId: p.projectId,
      taskIdentifier: p.taskIdentifier ?? "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: p.traceId,
      spanId: p.spanId,
      parentSpanId: p.parentSpanId,
      runTags: [],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: p.projectId,
      organizationId: p.organizationId,
    },
  };
}

// Build the split router. `legacyLag` configures the legacy store's frozen replica.
function buildRouter(
  prisma14: PrismaClient,
  prisma17: RunOpsPrismaClient,
  legacyLag: Parameters<typeof laggingReplica>[1]
) {
  const legacyReplica = laggingReplica(prisma14, legacyLag);
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

function spansRequest(runId: string, spanId: string) {
  return {
    request: new Request(`https://api.trigger.dev/api/v1/runs/${runId}/spans/${spanId}`, {
      headers: { Authorization: "Bearer tr_dev_x" },
    }),
    params: { runId, spanId },
    context: {} as never,
  };
}
function traceRequest(runId: string) {
  return {
    request: new Request(`https://api.trigger.dev/api/v1/runs/${runId}/trace`, {
      headers: { Authorization: "Bearer tr_dev_x" },
    }),
    params: { runId },
    context: {} as never,
  };
}
function syncRequest(traceId: string) {
  return {
    request: new Request(`https://app.trigger.dev/sync/traces/runs/${traceId}?live=true`),
    params: { traceId },
    context: {} as never,
  } as never;
}

describe("run-trace/span-detail route loaders under a lagging replica", () => {
  // spans loader — findResource findRun ($replica)
  heteroRunOpsPostgresTest(
    "spans loader: replica+buffer double-miss returns a retryable 404 (x-should-retry:true), self-healing to 200 once the replica catches up",
    async ({ prisma14, prisma17 }) => {
      const suffix = `spans_find_${seq++}`;
      const seed = await seedTenant(prisma14, suffix);
      const runId = `run_${CUID_25}`;
      const friendlyId = `run_${suffix}`;

      // Seed the live run on the LEGACY primary (writer) only.
      const lagged = buildRouter(prisma14, prisma17, [{ model: "taskRun", mode: "missing" }]);
      await lagged.legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          traceId: `trace_${suffix}`,
          spanId: `span_${suffix}`,
        })
      );

      holder.store = lagged.router;
      holder.environment = authEnvironment(seed);
      holder.bufferResult = null;

      const res = (await spansLoader(spansRequest(friendlyId, `span_${suffix}`))) as Response;

      // The frozen replica WAS consulted (the lag was really exercised).
      expect(lagged.legacyReplica.wasHit("taskRun")).toBe(true);
      // The caller emits the documented RETRYABLE not-found, not a terminal 404.
      expect(res.status).toBe(404);
      expect(res.headers.get("x-should-retry")).toBe("true");

      // Self-heal proof: point the store at a NON-lagging replica (replica caught up == the SDK retry
      // landing after replication) and the SAME loader now resolves the run and returns 200.
      holder.span = {
        spanId: `span_${suffix}`,
        parentId: undefined,
        message: "root",
        isError: false,
        isPartial: false,
        isCancelled: false,
        level: "TRACE",
        startTime: new Date(),
        duration: 1_000_000,
        properties: undefined,
        events: undefined,
        entity: { type: "task" },
      };
      const caughtUp = buildRouter(prisma14, prisma17, []); // no models frozen
      holder.store = caughtUp.router;
      const res2 = (await spansLoader(spansRequest(friendlyId, `span_${suffix}`))) as Response;
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as { runId?: string; spanId?: string };
      expect(body2.runId).toBe(friendlyId);
      expect(body2.spanId).toBe(`span_${suffix}`);
    }
  );

  // spans loader — handler findRuns triggeredRuns ($replica)
  heteroRunOpsPostgresTest(
    "spans loader: a just-triggered child on the primary is omitted from triggeredRuns under lag (200, list self-heals)",
    async ({ prisma14, prisma17 }) => {
      const suffix = `spans_children_${seq++}`;
      const seed = await seedTenant(prisma14, suffix);
      const parentRunId = `run_${CUID_25}`;
      const parentFriendlyId = `run_${suffix}_p`;
      const spanId = `span_${suffix}`;

      // Seed the parent run AND a child run (parentSpanId = spanId) on the LEGACY primary.
      const writerStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      await writerStore.createRun(
        buildCreateRunInput({
          runId: parentRunId,
          friendlyId: parentFriendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          traceId: `trace_${suffix}`,
          spanId,
        })
      );
      const childRunId = `run_${"d".repeat(25)}`;
      const childFriendlyId = `run_${suffix}_c`;
      await writerStore.createRun(
        buildCreateRunInput({
          runId: childRunId,
          friendlyId: childFriendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          traceId: `trace_${suffix}`,
          spanId: `childspan_${suffix}`,
          parentSpanId: spanId,
          taskIdentifier: "child-task",
        })
      );

      // Capture the PARENT row as the frozen replica snapshot (== "parent replicated, child written
      // after and not yet replicated"). The parent resolves on the replica; the child does not.
      const parentSnapshot = (await prisma14.taskRun.findFirstOrThrow({
        where: { id: parentRunId },
      })) as unknown as Record<string, unknown>;

      const lagged = buildRouter(prisma14, prisma17, [
        { model: "taskRun", mode: "frozen", rows: [parentSnapshot] },
      ]);
      holder.store = lagged.router;
      holder.environment = authEnvironment(seed);
      holder.bufferResult = null;
      holder.span = {
        spanId,
        parentId: undefined,
        message: "root",
        isError: false,
        isPartial: false,
        isCancelled: false,
        level: "TRACE",
        startTime: new Date(),
        duration: 2_000_000,
        properties: undefined,
        events: undefined,
        entity: { type: "task" },
      };

      const res = (await spansLoader(spansRequest(parentFriendlyId, spanId))) as Response;
      const body = (await res.json()) as { runId?: string; triggeredRuns?: unknown };

      // The parent resolved via the (frozen) replica, so the read genuinely went through it.
      expect(lagged.legacyReplica.wasHit("taskRun")).toBe(true);
      // 200 with the span, and the lagging child is simply OMITTED from the list.
      expect(res.status).toBe(200);
      expect(body.runId).toBe(parentFriendlyId);
      expect(body.triggeredRuns).toBeUndefined();

      // Prove the omission is lag (the child is present on the primary right now).
      const onPrimary = await prisma14.taskRun.findMany({
        where: { runtimeEnvironmentId: seed.environment.id, parentSpanId: spanId },
        select: { friendlyId: true },
      });
      expect(onPrimary.map((r) => r.friendlyId)).toContain(childFriendlyId);
    }
  );

  // trace loader — findResource findRun ($replica)
  heteroRunOpsPostgresTest(
    "trace loader: replica+buffer double-miss returns a retryable 404 (x-should-retry:true), self-healing to 200 once the replica catches up",
    async ({ prisma14, prisma17 }) => {
      const suffix = `trace_find_${seq++}`;
      const seed = await seedTenant(prisma14, suffix);
      const runId = `run_${CUID_25}`;
      const friendlyId = `run_${suffix}`;

      const lagged = buildRouter(prisma14, prisma17, [{ model: "taskRun", mode: "missing" }]);
      await lagged.legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          traceId: `trace_${suffix}`,
          spanId: `span_${suffix}`,
        })
      );

      holder.store = lagged.router;
      holder.environment = authEnvironment(seed);
      holder.bufferResult = null;

      const res = (await traceLoader(traceRequest(friendlyId))) as Response;
      expect(lagged.legacyReplica.wasHit("taskRun")).toBe(true);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-should-retry")).toBe("true");

      // Self-heal proof: caught-up replica -> the same loader resolves the run and returns the trace.
      holder.traceSummary = { rootSpanId: `span_${suffix}`, spans: [] };
      const caughtUp = buildRouter(prisma14, prisma17, []);
      holder.store = caughtUp.router;
      const res2 = (await traceLoader(traceRequest(friendlyId))) as Response;
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as { trace?: unknown };
      expect(body2.trace).toEqual({ rootSpanId: `span_${suffix}`, spans: [] });
    }
  );

  // sync trace-runs loader — findRun by traceId ($replica), with a primary fallback
  heteroRunOpsPostgresTest(
    "sync trace-runs loader: a live run lagging the replica is recovered via the primary fallback",
    async ({ prisma14, prisma17 }) => {
      const suffix = `sync_${seq++}`;
      const seed = await seedTenant(prisma14, suffix);
      const runId = `run_${CUID_25}`;
      const friendlyId = `run_${suffix}`;
      const traceId = "a".repeat(32);
      const userId = `user_${suffix}`;

      // The dashboard user, joined to the org so the route's real orgMember check passes.
      await prisma14.user.create({
        data: { id: userId, email: `u-${suffix}@example.com`, authenticationMethod: "MAGIC_LINK" },
      });
      await prisma14.orgMember.create({
        data: { userId, organizationId: seed.organization.id, role: "ADMIN" },
      });

      const lagged = buildRouter(prisma14, prisma17, [{ model: "taskRun", mode: "missing" }]);
      await lagged.legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          traceId,
          spanId: `span_${suffix}`,
        })
      );

      holder.store = lagged.router;
      holder.environment = authEnvironment(seed);
      holder.userId = userId;
      holder.resolvedEnv = { organizationId: seed.organization.id };
      holder.replicaMarker = { orgMember: prisma14.orgMember };

      const res = (await syncTraceRunsLoader(syncRequest(traceId))) as Response;

      // The frozen replica WAS consulted (the lag was really exercised).
      expect(lagged.legacyReplica.wasHit("taskRun")).toBe(true);

      // The primary fallback recovers the live run and the loader proceeds to the shape stream (200).
      expect(res.status).toBe(200);
      expect(res.headers.get("x-longpoll")).toBe("hit");
    }
  );

  // Negative control for the sync route: a truly-absent run must still 404 (the primary fallback
  // recovers a LIVE run, it does not turn every miss into a 200).
  heteroRunOpsPostgresTest(
    "sync trace-runs loader: 404s when the run is absent on the primary too",
    async ({ prisma14, prisma17 }) => {
      const suffix = `sync_absent_${seq++}`;
      const seed = await seedTenant(prisma14, suffix);
      const userId = `user_${suffix}`;
      await prisma14.user.create({
        data: { id: userId, email: `u-${suffix}@example.com`, authenticationMethod: "MAGIC_LINK" },
      });
      await prisma14.orgMember.create({
        data: { userId, organizationId: seed.organization.id, role: "ADMIN" },
      });

      const lagged = buildRouter(prisma14, prisma17, [{ model: "taskRun", mode: "missing" }]);
      holder.store = lagged.router;
      holder.environment = authEnvironment(seed);
      holder.userId = userId;
      holder.resolvedEnv = { organizationId: seed.organization.id };
      holder.replicaMarker = { orgMember: prisma14.orgMember };

      const res = (await syncTraceRunsLoader(syncRequest("b".repeat(32)))) as Response;
      expect(lagged.legacyReplica.wasHit("taskRun")).toBe(true);
      expect(res.status).toBe(404);
    }
  );
});
