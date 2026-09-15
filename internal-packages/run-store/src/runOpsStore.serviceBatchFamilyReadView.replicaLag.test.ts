// Lagging-replica coverage for the batch-family reads issued by the batch services with NO client:
// findBatchTaskRunByIdempotencyKey (dedup), findBatchTaskRunById (batchTriggerV3 complete arm +
// tryCompleteBatchV3, runEngine batchTrigger, and three streamBatchItems checks), and
// countBatchTaskRunItems (tryCompleteBatchV3).
//
// The property every case proves: these three store methods are the batch-family PRIMARY defaulters. In
// the router, findBatchTaskRunById / findBatchTaskRunByIdempotencyKey fan out NEW→LEGACY and
// countBatchTaskRunItems routes by batchTaskRunId, each leg via #ownPrimary(store, undefined), which
// returns undefined for a null client; each PostgresRunStore method then falls back to
// `client ?? this.prisma` — the OWNING store's PRIMARY, not readOnlyPrisma. (Contrast
// findBatchTaskRunByFriendlyId / findManyBatchTaskRunItems, which default to readOnlyPrisma — covered
// separately.)
//
// So under owning-replica lag the just-written batch/items are found and no downstream decision is
// driven by a stale value: the dedup does not trigger a DUPLICATE batch; a stale null does not DROP
// batch completion, abort sealing, throw a spurious "Batch not found", or defeat the idempotent-retry
// short-circuit; a stale count does not fail to seal a finished batch. Each case asserts the frozen
// owning replica is NEVER consulted (wasHit === false) AND the row/count is correct — proving PRIMARY
// routing, not replica tolerance.
//
// Builds the RoutingRunStore as batchTriggerV3 / RunEngine hold it (a NEW dedicated store + a LEGACY
// control-plane store), seeds the batch (cuid id → LEGACY-owned) on the LEGACY PRIMARY, freezes the
// LEGACY replica with the shared laggingReplica primitive (batchTaskRun + batchTaskRunItem in "missing"
// mode), then invokes each read EXACTLY as the caller does (same method, same args, NO client).

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateBatchTaskRunData } from "./types.js";

// A cuid (25 chars after the `batch_` prefix) classifies LEGACY, so the batch + its items are owned by
// the legacy (control-plane) store; the client-less reads then fan out / route through the LEGACY leg.
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

// Build the RoutingRunStore exactly as the seam wires it: NEW = dedicated subset store (prisma17),
// LEGACY = control-plane store (prisma14) whose REPLICA is the frozen lagging client. The batch models
// are frozen in "missing" mode: if any batch read were replica-routed it would come back null/[]/0 AND
// flip wasHit — so wasHit(false) + a correct result together prove PRIMARY routing.
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
    friendlyId: "batch_svc_family_f",
    runtimeEnvironmentId: "PLACEHOLDER",
    status: "PENDING",
    runCount: 1,
    expectedCount: 1,
    batchVersion: "runengine:v2",
    sealed: false,
    ...overrides,
  };
}

// Seed BatchTaskRunItem rows on the LEGACY primary with FK triggers disabled (no real TaskRun needed —
// countBatchTaskRunItems only matches batchTaskRunId + status).
async function seedItems(
  prisma: PrismaClient,
  opts: { batchTaskRunId: string; status: string; count: number; idPrefix: string }
) {
  // `session_replication_role` is session-scoped, so `SET` and the inserts must share one connection —
  // separate pooled Prisma calls can land on different connections, leaving the inserts with FK triggers
  // still enabled. Run them in a single transaction with `SET LOCAL`, which applies for the duration of
  // this transaction (same connection) and auto-resets on commit.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    for (let i = 0; i < opts.count; i++) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "BatchTaskRunItem" (id, status, "batchTaskRunId", "taskRunId", "createdAt", "updatedAt")
         VALUES ($1, $2::"BatchTaskRunItemStatus", $3, $4, NOW(), NOW())`,
        `${opts.idPrefix}_${i}`,
        opts.status,
        opts.batchTaskRunId,
        `run_item_${opts.idPrefix}_${i}`
      );
    }
  });
}

describe("batch-service family batch reads (no client) route to the owning PRIMARY under replica lag", () => {
  // ── findBatchTaskRunByIdempotencyKey (dedup) ──────────────────────
  heteroRunOpsPostgresTest(
    "findBatchTaskRunByIdempotencyKey dedup hits the LEGACY primary, never the frozen replica (no duplicate batch)",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "bf_idem");
      const idempotencyKey = "batch-idem-key";
      await legacyStore.createBatchTaskRun(
        batchData({
          friendlyId: "batch_bf_idem_f",
          runtimeEnvironmentId: seed.environment.id,
          idempotencyKey,
          idempotencyKeyExpiresAt: new Date(Date.now() + 60 * 60_000),
        })
      );

      // Exact caller invocation: (environment.id, idempotencyKey), NO client.
      const found = await router.findBatchTaskRunByIdempotencyKey(
        seed.environment.id,
        idempotencyKey
      );

      expect(found).not.toBeNull();
      expect(found!.idempotencyKey).toBe(idempotencyKey);
      // Primary routing proof: the frozen LEGACY replica was never consulted.
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(false);
    }
  );

  // ── findBatchTaskRunById (complete arm) ────────────────────────────
  heteroRunOpsPostgresTest(
    "findBatchTaskRunById complete-arm lookup hits the LEGACY primary, never the frozen replica",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "bf_666");
      const batchId = `batch_${CUID_25}`;
      await legacyStore.createBatchTaskRun(
        batchData({
          id: batchId,
          friendlyId: "batch_bf_666_f",
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      const batch = await router.findBatchTaskRunById(batchId);

      expect(batch).not.toBeNull();
      expect(batch!.id).toBe(batchId);
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(false);
    }
  );

  // ── findBatchTaskRunById (tryCompleteBatchV3) ─────────────────────
  heteroRunOpsPostgresTest(
    "findBatchTaskRunById in tryCompleteBatchV3 hits the LEGACY primary, never the frozen replica",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "bf_1016");
      const batchId = `batch_${CUID_25}`;
      await legacyStore.createBatchTaskRun(
        batchData({
          id: batchId,
          friendlyId: "batch_bf_1016_f",
          runtimeEnvironmentId: seed.environment.id,
          status: "PENDING",
          sealed: true,
          expectedCount: 1,
        })
      );

      const batch = await router.findBatchTaskRunById(batchId);

      expect(batch).not.toBeNull();
      expect(batch!.id).toBe(batchId);
      // tryCompleteBatchV3 reads batch.status/sealed/expectedCount off this row — a stale null returns early.
      expect(batch!.sealed).toBe(true);
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(false);
    }
  );

  // ── countBatchTaskRunItems (tryCompleteBatchV3) ───────────────────
  heteroRunOpsPostgresTest(
    "countBatchTaskRunItems in tryCompleteBatchV3 counts on the LEGACY primary, never the frozen replica",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "bf_1033");
      const batchId = `batch_${CUID_25}`;
      await legacyStore.createBatchTaskRun(
        batchData({
          id: batchId,
          friendlyId: "batch_bf_1033_f",
          runtimeEnvironmentId: seed.environment.id,
          expectedCount: 3,
          runCount: 3,
        })
      );
      // 3 COMPLETED items on the LEGACY primary; the frozen replica would report 0.
      await seedItems(prisma14, {
        batchTaskRunId: batchId,
        status: "COMPLETED",
        count: 3,
        idPrefix: "bti_1033",
      });

      // Exact caller invocation: ({ batchTaskRunId, status }), NO client.
      const completedCount = await router.countBatchTaskRunItems({
        batchTaskRunId: batchId,
        status: "COMPLETED",
      });

      expect(completedCount).toBe(3);
      // Primary routing proof: the frozen LEGACY item replica was never consulted (else it returns 0).
      expect(legacyReplica.wasHit("batchTaskRunItem")).toBe(false);
    }
  );

  // ── runEngine batchTrigger findBatchTaskRunById ──────────────────────────
  heteroRunOpsPostgresTest(
    "findBatchTaskRunById in runEngine batchTrigger hits the LEGACY primary, never the frozen replica",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "bf_360");
      const batchId = `batch_${CUID_25}`;
      await legacyStore.createBatchTaskRun(
        batchData({
          id: batchId,
          friendlyId: "batch_bf_360_f",
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      const batch = await router.findBatchTaskRunById(batchId);

      expect(batch).not.toBeNull();
      expect(batch!.id).toBe(batchId);
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(false);
    }
  );

  // ── streamBatchItems findBatchTaskRunById (validate exists) ───────────────────────
  heteroRunOpsPostgresTest(
    "findBatchTaskRunById existence check in streamBatchItems hits the LEGACY primary, never the frozen replica",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "bf_134");
      const batchId = `batch_${CUID_25}`;
      await legacyStore.createBatchTaskRun(
        batchData({
          id: batchId,
          friendlyId: "batch_bf_134_f",
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      const batch = await router.findBatchTaskRunById(batchId);

      // The caller does: `if (!batch || batch.runtimeEnvironmentId !== environment.id) throw 404`.
      expect(batch).not.toBeNull();
      expect(batch!.runtimeEnvironmentId).toBe(seed.environment.id);
      const wouldThrow404 = !batch || batch.runtimeEnvironmentId !== seed.environment.id;
      expect(wouldThrow404).toBe(false);
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(false);
    }
  );

  // ── streamBatchItems findBatchTaskRunById (idempotent-retry recheck) ──────────────
  heteroRunOpsPostgresTest(
    "findBatchTaskRunById idempotent-retry recheck in streamBatchItems hits the LEGACY primary, never the frozen replica",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "bf_206");
      const batchId = `batch_${CUID_25}`;
      await legacyStore.createBatchTaskRun(
        batchData({
          id: batchId,
          friendlyId: "batch_bf_206_f",
          runtimeEnvironmentId: seed.environment.id,
          status: "COMPLETED",
          sealed: true,
          processingCompletedAt: new Date(),
        })
      );

      const currentBatch = await router.findBatchTaskRunById(batchId);

      expect(currentBatch).not.toBeNull();
      // isIdempotentRetrySuccess(status, sealed, processingCompletedAt) reads these three off the row.
      expect(currentBatch!.status).toBe("COMPLETED");
      expect(currentBatch!.sealed).toBe(true);
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(false);
    }
  );

  // ── streamBatchItems findBatchTaskRunById (idempotent-retry recheck, second) ──────────────
  heteroRunOpsPostgresTest(
    "findBatchTaskRunById idempotent-retry recheck (second) in streamBatchItems hits the LEGACY primary, never the frozen replica",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "bf_294");
      const batchId = `batch_${CUID_25}`;
      await legacyStore.createBatchTaskRun(
        batchData({
          id: batchId,
          friendlyId: "batch_bf_294_f",
          runtimeEnvironmentId: seed.environment.id,
          status: "COMPLETED",
          sealed: true,
          processingCompletedAt: new Date(),
        })
      );

      const currentBatch = await router.findBatchTaskRunById(batchId);

      expect(currentBatch).not.toBeNull();
      expect(currentBatch!.status).toBe("COMPLETED");
      expect(currentBatch!.sealed).toBe(true);
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(false);
    }
  );
});
