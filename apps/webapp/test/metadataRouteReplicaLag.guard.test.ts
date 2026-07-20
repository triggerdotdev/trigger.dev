// Property: the metadata GET loader resolves a live run on a replica+buffer double-miss via its primary
// fallback, returning 200 + the run's metadata. Drives the REAL exported `loader` end-to-end:
//   1. runStore.findRun(..., $replica)        → REPLICA (lagging) → null
//   2. findRunByIdWithMollifierFallback(...)   → buffer MISS (null)
//   3. runStore.findRunOnPrimary(...)          → owning PRIMARY → HIT
// Store is REAL: a split RoutingRunStore over two testcontainer Postgres DBs, the owning
// (legacy/control-plane) REPLICA frozen behind the shared laggingReplica. Only the loader's webapp
// singletons (auth, $replica brand, mollifier buffer, route builder, logging) are stubbed.

import { describe, expect, vi } from "vitest";
import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";

// vi.mock factories are hoisted above the imports, so anything they reference must be created inside
// vi.hoisted. `holder.store` is filled in per-test with the REAL split router; the mocked
// `~/v3/runStore.server` export is a stable Proxy that forwards every property access to it. The
// branded `$replica` marker uses the global-registry symbol the run-store brands replicas with
// (readReplicaClient.ts) — a branded client makes the routing store keep the read on the owning
// REPLICA (no primary escalation), which under lag is exactly the miss the primary fallback recovers.
const { holder } = vi.hoisted(() => {
  const REPLICA_BRAND = Symbol.for("trigger.dev/run-store/read-replica");
  return {
    holder: {
      store: undefined as unknown,
      brandedReplica: { [REPLICA_BRAND]: true } as object,
      environment: undefined as unknown,
      bufferResult: null as unknown,
    },
  };
});

vi.mock("~/db.server", () => ({ prisma: {}, $replica: holder.brandedReplica }));
vi.mock("~/env.server", () => ({
  env: {
    TASK_RUN_METADATA_MAXIMUM_SIZE: 256 * 1024,
    TRIGGER_MOLLIFIER_METADATA_MAX_RETRIES: 3,
    TRIGGER_MOLLIFIER_METADATA_BACKOFF_BASE_MS: 10,
    TRIGGER_MOLLIFIER_METADATA_BACKOFF_STEP_MS: 10,
  },
}));
// The route module builds its action at import time via createActionApiRoute; stub the builder so the
// heavy platform/auth middleware graph never evaluates. We drive the exported `loader` directly.
vi.mock("~/services/routeBuilders/apiBuilder.server", () => ({
  createActionApiRoute: () => ({ action: vi.fn() }),
}));
vi.mock("~/services/apiAuth.server", () => ({
  authenticateApiRequest: vi.fn(async () => ({ environment: holder.environment })),
}));
// Inject the REAL split router. A stable Proxy keeps the named import binding constant while
// forwarding every method to the per-test router set in holder.store.
vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_target, prop) {
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
// Buffer fallback returns whatever the test set (null = buffer miss, the double-miss scenario).
vi.mock("~/v3/mollifier/readFallback.server", () => ({
  findRunByIdWithMollifierFallback: vi.fn(async () => holder.bufferResult),
}));
// Action-only leaf; stub to keep the import graph light.
vi.mock("~/v3/mollifier/applyMetadataMutation.server", () => ({
  applyMetadataMutationToBufferedRun: vi.fn(),
}));
vi.mock("~/services/metadata/updateMetadataInstance.server", () => ({
  updateMetadataService: { call: vi.fn(async () => undefined) },
}));
vi.mock("~/v3/services/common.server", () => ({
  ServiceValidationError: class extends Error {},
}));
vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { loader } from "~/routes/api.v1.runs.$runId.metadata";

// A cuid (25 chars after `run_`) classifies LEGACY, so both the create and the friendlyId-keyed reads
// route to the legacy (control-plane) store — the store that owns this run.
const CUID_25 = "c".repeat(25);

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

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  metadata?: string;
  metadataType?: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      metadata: params.metadata,
      metadataType: params.metadataType,
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_1",
      spanId: "span_1",
      runTags: ["alpha"],
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
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

function buildRouterWithLaggingLegacyReplica(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
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
  return { router, legacyStore, legacyReplica };
}

async function callLoader(friendlyId: string) {
  const response = await loader({
    request: new Request("https://api.trigger.dev/api/v1/runs/" + friendlyId + "/metadata", {
      headers: { Authorization: "Bearer tr_dev_meta" },
    }),
    params: { runId: friendlyId },
    context: {} as never,
  });
  return response as Response;
}

describe("metadata GET loader under replica lag", () => {
  heteroRunOpsPostgresTest(
    "metadata GET loader resolves a live run on a replica and buffer double-miss",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouterWithLaggingLegacyReplica(
        prisma14,
        prisma17
      );

      const seed = await seedEnvironmentLegacy(prisma14, "meta");
      const runId = `run_${CUID_25}`; // cuid → LEGACY-owned
      const friendlyId = "run_meta_live";
      const metadata = '{"phase":"one"}';
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          metadata,
          metadataType: "application/json",
        })
      );

      // Wire the loader's module singletons: the real split router, the authenticated env, and a
      // buffer that MISSES (the run has drained from the buffer to the primary but the replica has
      // not caught up — the exact double-miss under test).
      holder.store = router;
      holder.environment = { id: seed.environment.id, organizationId: seed.organization.id };
      holder.bufferResult = null;

      const response = await callLoader(friendlyId);
      const body = (await response.json()) as {
        metadata?: unknown;
        metadataType?: unknown;
        error?: string;
      };

      // The replica WAS consulted (and, being frozen, missed) — proving the read genuinely went
      // through the lagging replica and the recovery is the primary fallback, not a lucky replica hit.
      expect(legacyReplica.wasHit()).toBe(true);

      // The property: the loader re-reads the owning primary and returns the live run's metadata.
      expect(response.status).toBe(200);
      expect(body.metadata).toBe(metadata);
      expect(body.metadataType).toBe("application/json");
    }
  );

  // Negative control: when the run truly does not exist anywhere (replica miss + buffer miss +
  // primary miss), the loader must still 404. This pins the behavior to "recover a LIVE run" rather
  // than "never 404".
  heteroRunOpsPostgresTest(
    "metadata GET loader 404s when the run is absent on the primary too",
    async ({ prisma14, prisma17 }) => {
      const { router } = buildRouterWithLaggingLegacyReplica(prisma14, prisma17);
      const seed = await seedEnvironmentLegacy(prisma14, "meta_absent");

      holder.store = router;
      holder.environment = { id: seed.environment.id, organizationId: seed.organization.id };
      holder.bufferResult = null;

      const response = await callLoader("run_does_not_exist");
      expect(response.status).toBe(404);
    }
  );
});
