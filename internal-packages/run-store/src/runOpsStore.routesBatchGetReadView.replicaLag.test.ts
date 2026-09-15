// Coverage for the batch-GET route/loader reads issued with NO client, grouped as "routes-batch-get".
// Five external-API callers, two store methods routed differently:
//
//   api.v1.batches.$batchId       findBatchTaskRunByFriendlyId(id, env.id, {errors})  [GET]
//   api.v2.batches.$batchId       findBatchTaskRunByFriendlyId(id, env.id, {errors})  [GET]
//   realtime.v1.batches.$batchId  findBatchTaskRunByFriendlyId(id, env.id)             [subscribe]
//   api.v3.batches                findBatchTaskRunById(cachedRequestId)  [request-idempotency dedup]
//   api.v2.tasks.batch            findBatchTaskRunById(cachedRequestId)  [request-idempotency dedup]
//
// Routing. The router fans BOTH methods out NEW→LEGACY, each leg via #ownPrimary(store, client). For a
// NO-client call #ownPrimary returns undefined, so each leg falls to the store default — and the two
// methods default DIFFERENTLY in PostgresRunStore:
//   - findBatchTaskRunByFriendlyId  `client ?? this.readOnlyPrisma`  → REPLICA
//   - findBatchTaskRunById          `client ?? this.prisma`          → PRIMARY
// So the three friendlyId GET/subscribe callers read the owning REPLICA; the two byId dedup callers read
// the owning PRIMARY. Every case proves its routing (frozen owning replica consulted, or not).
//
// findBatchTaskRunByFriendlyId (REPLICA) — api.v1 / api.v2 / realtime.v1:
//   The friendlyId is looked up on the owning REPLICA. Under lag a just-created batch (committed to the
//   owning PRIMARY) is not yet visible → the read returns null → createLoaderApiRoute short-circuits with
//   `{ error: "Not found" }, status 404` and header `x-should-retry: false`, which the SDK obeys verbatim
//   (no retry). The batch is live on the owning primary, recoverable via a primary re-read (asserted
//   below). Contrast the sibling RUN-get routes, which set `shouldRetryNotFound: true` so the SDK retries
//   the 404 through lag.
//
// findBatchTaskRunById (PRIMARY) — api.v3.batches / api.v2.tasks.batch — tolerated:
//   The request-idempotency dedup (handleRequestIdempotency.findCachedEntity) looks up the cached batch
//   by id on the owning PRIMARY. Under owning-replica lag the just-written batch is still found, so the
//   retried create returns isCached instead of minting a DUPLICATE batch. Tolerance = PRIMARY routing,
//   proven by wasHit("batchTaskRun") === false (the frozen replica is never consulted) AND a correct row.
//
// Build the RoutingRunStore as the webapp holds it (NEW = dedicated subset store / prisma17; LEGACY =
// control-plane store / prisma14 whose REPLICA is the frozen lagging client). Seed the batch (cuid id →
// LEGACY-owned) on the LEGACY PRIMARY, freeze the LEGACY replica (batchTaskRun + batchTaskRunItem,
// "missing") with the shared laggingReplica, then invoke each read EXACTLY as the caller does — same
// method, same args, NO client. Real split topology via heteroRunOpsPostgresTest — never mocked.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateBatchTaskRunData } from "./types.js";

// A cuid (25 chars after the `batch_` prefix) classifies LEGACY, so the batch is owned by the legacy
// (control-plane) store; the client-less reads then fan out / land on the LEGACY leg.
const CUID_25 = "c".repeat(25);

async function seedEnvironment(prisma: PrismaClient, slugSuffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${slugSuffix}`, slug: `org-${slugSuffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${slugSuffix}`,
      slug: `project-${slugSuffix}`,
      externalRef: `proj_${slugSuffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slugSuffix}`,
      pkApiKey: `pk_dev_${slugSuffix}`,
      shortcode: `short_${slugSuffix}`,
    },
  });
  return { organization, project, environment };
}

// Build the RoutingRunStore the same way the webapp does. The LEGACY replica is frozen in "missing" mode
// for the batch models: any REPLICA-routed batch read comes back null/[]/0 AND flips wasHit — so
// wasHit(true) + a null result proves REPLICA routing (the findBatchTaskRunByFriendlyId cases above),
// and wasHit(false) + a correct row proves PRIMARY routing (the findBatchTaskRunById cases).
function buildLaggingRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyReplica = laggingReplica(prisma14, [
    { model: "batchTaskRun", mode: "missing" },
    { model: "batchTaskRunItem", mode: "missing" },
  ]);
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

function batchData(overrides: Partial<CreateBatchTaskRunData>): CreateBatchTaskRunData {
  return {
    id: `batch_${CUID_25}`,
    friendlyId: "batch_route_get_f",
    runtimeEnvironmentId: "PLACEHOLDER",
    status: "PENDING",
    runCount: 1,
    runIds: ["run_child_1"],
    expectedCount: 1,
    batchVersion: "runengine:v2",
    sealed: false,
    ...overrides,
  };
}

// Reproduce the createLoaderApiRoute resource gate + the SDK's header obedience: a null findResource →
// 404 with x-should-retry "false" → the SDK returns { retry: false }. This is the mechanism that turns a
// stale replica null into a NON-RETRYABLE 404. `shouldRetryNotFound` is UNSET on all three batch routes.
function routeOutcomeForResource(
  resource: unknown,
  opts: { shouldRetryNotFound?: boolean } = {}
): { status: number; xShouldRetry: string | null; sdkWillRetry: boolean } {
  if (!resource) {
    const xShouldRetry = opts.shouldRetryNotFound ? "true" : "false";
    return { status: 404, xShouldRetry, sdkWillRetry: xShouldRetry === "true" };
  }
  return { status: 200, xShouldRetry: null, sdkWillRetry: false };
}

describe("batch-GET route reads under replica lag", () => {
  // api.v1.batches — findBatchTaskRunByFriendlyId (REPLICA).
  heteroRunOpsPostgresTest(
    "api.v1.batches findBatchTaskRunByFriendlyId reads stale-null under replica lag, yielding a non-retryable 404",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "bget_v1");
      const friendlyId = "batch_bget_v1_f";
      await legacyStore.createBatchTaskRun(
        batchData({ friendlyId, runtimeEnvironmentId: seed.environment.id })
      );

      // Exact caller invocation: (friendlyId, environment.id, { include: { errors: true } }), NO client.
      const underLag = await router.findBatchTaskRunByFriendlyId(friendlyId, seed.environment.id, {
        include: { errors: true },
      });

      // Stale null for a batch that exists on the primary → the route's resource gate fires.
      expect(underLag).toBeNull();
      // REPLICA routing proof: the frozen owning replica WAS consulted (this is the split hazard).
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(true);

      // The replica-routed miss yields a non-retryable 404 of a LIVE batch.
      const outcome = routeOutcomeForResource(underLag); // shouldRetryNotFound unset on this route
      expect(outcome.status).toBe(404);
      expect(outcome.xShouldRetry).toBe("false");
      expect(outcome.sdkWillRetry).toBe(false);

      // The null is PURELY replica lag + replica routing, not a missing row / bad query. Passing the
      // owning WRITER escalates the LEGACY leg to its PRIMARY (#ownPrimary) and the batch is found — a
      // primary route / primary re-read resolves it.
      const onPrimary = await router.findBatchTaskRunByFriendlyId(
        friendlyId,
        seed.environment.id,
        { include: { errors: true } },
        prisma14 as never
      );
      expect(onPrimary).not.toBeNull();
      expect(onPrimary!.friendlyId).toBe(friendlyId);
      expect(Array.isArray(onPrimary!.errors)).toBe(true);
      expect(routeOutcomeForResource(onPrimary).status).toBe(200);
    }
  );

  // api.v2.batches — findBatchTaskRunByFriendlyId (REPLICA).
  heteroRunOpsPostgresTest(
    "api.v2.batches findBatchTaskRunByFriendlyId reads stale-null under replica lag, yielding a non-retryable 404",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "bget_v2");
      const friendlyId = "batch_bget_v2_f";
      await legacyStore.createBatchTaskRun(
        batchData({
          friendlyId,
          runtimeEnvironmentId: seed.environment.id,
          processingCompletedAt: new Date(),
        })
      );

      const underLag = await router.findBatchTaskRunByFriendlyId(friendlyId, seed.environment.id, {
        include: { errors: true },
      });
      expect(underLag).toBeNull();
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(true);

      const outcome = routeOutcomeForResource(underLag);
      expect(outcome.status).toBe(404);
      expect(outcome.sdkWillRetry).toBe(false);

      const onPrimary = await router.findBatchTaskRunByFriendlyId(
        friendlyId,
        seed.environment.id,
        { include: { errors: true } },
        prisma14 as never
      );
      expect(onPrimary).not.toBeNull();
      expect(onPrimary!.friendlyId).toBe(friendlyId);
    }
  );

  // realtime.v1.batches — findBatchTaskRunByFriendlyId (REPLICA).
  heteroRunOpsPostgresTest(
    "realtime.v1.batches findBatchTaskRunByFriendlyId reads stale-null under replica lag, 404ing before the subscription starts",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "bget_rt");
      const friendlyId = "batch_bget_rt_f";
      const batchId = `batch_${CUID_25}`;
      await legacyStore.createBatchTaskRun(
        batchData({ id: batchId, friendlyId, runtimeEnvironmentId: seed.environment.id })
      );

      // Exact caller invocation: (friendlyId, environment.id) — NO include, NO client.
      const underLag = await router.findBatchTaskRunByFriendlyId(friendlyId, seed.environment.id);
      expect(underLag).toBeNull();
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(true);

      // The loader returns 404 at the resource gate BEFORE reaching streamBatch — the subscription
      // never starts. shouldRetryNotFound is unset here too → non-retryable.
      const outcome = routeOutcomeForResource(underLag);
      expect(outcome.status).toBe(404);
      expect(outcome.sdkWillRetry).toBe(false);

      // Owning WRITER escalates to the LEGACY primary; batchRun.id (fed to streamBatch) resolves.
      const onPrimary = await router.findBatchTaskRunByFriendlyId(
        friendlyId,
        seed.environment.id,
        undefined,
        prisma14 as never
      );
      expect(onPrimary).not.toBeNull();
      expect(onPrimary!.id).toBe(batchId);
    }
  );

  // api.v3.batches — findBatchTaskRunById (PRIMARY) — tolerated.
  heteroRunOpsPostgresTest(
    "api.v3.batches findBatchTaskRunById reads the primary for idempotency dedup, finding the cached batch under replica lag",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "bget_v3");
      const batchId = `batch_${CUID_25}`;
      const friendlyId = "batch_bget_v3_f";
      await legacyStore.createBatchTaskRun(
        batchData({
          id: batchId,
          friendlyId,
          runtimeEnvironmentId: seed.environment.id,
          runCount: 3,
        })
      );

      // Exact caller invocation: findCachedEntity(cachedRequestId) → findBatchTaskRunById(id), NO client.
      const cached = await router.findBatchTaskRunById(batchId);

      // PRIMARY routing proof: the just-written batch is found DESPITE the frozen replica...
      expect(cached).not.toBeNull();
      expect(cached!.id).toBe(batchId);
      // ...and the frozen owning replica was NEVER consulted (tolerance = primary routing, not lag-toleration).
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(false);

      // Reproduce the caller's dedup branch (findCachedEntity): env-match + non-null → buildResponse
      // returns isCached, so the retried create does NOT mint a duplicate batch.
      const dedupHit = !!cached && cached.runtimeEnvironmentId === seed.environment.id;
      expect(dedupHit).toBe(true);
      expect(cached!.friendlyId).toBe(friendlyId);
      expect(cached!.runCount).toBe(3);

      // Env-scope guard: a foreign environment must reject the cached entity (→ null → re-create).
      const foreignEnv =
        !!cached && cached.runtimeEnvironmentId === "env_does_not_exist" ? cached : null;
      expect(foreignEnv).toBeNull();
    }
  );

  // api.v2.tasks.batch — findBatchTaskRunById (PRIMARY) — tolerated.
  heteroRunOpsPostgresTest(
    "api.v2.tasks.batch findBatchTaskRunById reads the primary for dedup, finding the cached batch under replica lag",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "bget_tb");
      const batchId = `batch_${CUID_25}`;
      const friendlyId = "batch_bget_tb_f";
      await legacyStore.createBatchTaskRun(
        batchData({
          id: batchId,
          friendlyId,
          runtimeEnvironmentId: seed.environment.id,
          runCount: 5,
        })
      );

      const cached = await router.findBatchTaskRunById(batchId);

      expect(cached).not.toBeNull();
      expect(cached!.id).toBe(batchId);
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(false);

      // Dedup branch: env-match + non-null → buildResponse returns { id: friendlyId, runCount }.
      expect(cached!.runtimeEnvironmentId).toBe(seed.environment.id);
      expect(cached!.friendlyId).toBe(friendlyId);
      expect(cached!.runCount).toBe(5);
    }
  );
});
