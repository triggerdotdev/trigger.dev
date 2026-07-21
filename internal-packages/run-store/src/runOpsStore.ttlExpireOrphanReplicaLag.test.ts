// Guard for the run-ops split read-after-write property on the TTL BATCH EXPIRY path.
//
// TtlSystem.expireRunsBatch reads the runs it is about to expire with
//     runStore.findRuns({ where: { id: { in: runIds } }, select: {...} }, this.$.prisma)
// threading the owning primary (as the single-run path expireRun does), so it reads the run it just
// wrote. Why that matters: a client-less findRuns is NOT a read-your-writes signal, so RoutingRunStore
// routes each leg to the owning store's REPLICA. A run whose row is not yet visible there comes back
// absent, is bucketed `not_found`, skipped, and never expired — and since the TTL Lua script has
// ALREADY removed the run from the Redis queue before this guard runs, that miss does not self-heal:
// the run would be permanently ORPHANED (never expired, never emits `runExpired`, never re-queued).
//
// This is the weakest of the read-after-write class: the run row is usually written well before TTL
// fires, so a lagging replica has normally caught up. The window only exists for a very-short-TTL run
// swept moments after creation. This test forces the lag with the shared lagging-replica primitive
// and pins both paths: the primary-threaded read (the production path) expires the run, while the
// client-less path misses it on the replica and buckets it not_found.
//
// Deterministic via heteroRunOpsPostgresTest (real split topology, NEVER mocked): a LEGACY-resident
// (cuid) run is created on the control-plane writer; the control-plane replica lags (its `taskRun`
// reads come back empty). We drive the EXACT guard logic ttlSystem.expireRunsBatch uses.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput, ReadClient } from "./types.js";

// ownerEngine (classifyResidency) routes a run-ops v1 body → NEW, everything else → LEGACY.
const CUID_25 = "d".repeat(25); // → LEGACY (control-plane / prisma14, full schema)

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

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
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
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_1",
      spanId: "span_1",
      runTags: [],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      ttl: "1s",
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

// A line-for-line mirror of the guard in TtlSystem.expireRunsBatch: read the candidate runs, filter
// to PENDING+unlocked, and bucket every candidate id whose row is absent as `not_found`. `readClient`
// models the two paths: the client-less batch guard passes nothing (replica default); the
// read-your-writes path threads the primary (as single-run expireRun does).
async function guardExpireBatch(
  runStore: RoutingRunStore,
  runIds: string[],
  readClient?: ReadClient
): Promise<{ expired: string[]; skipped: { runId: string; reason: string }[] }> {
  const expired: string[] = [];
  const skipped: { runId: string; reason: string }[] = [];

  const runs = (await runStore.findRuns(
    {
      where: { id: { in: runIds } },
      select: {
        id: true,
        spanId: true,
        status: true,
        lockedAt: true,
        ttl: true,
        taskEventStore: true,
        createdAt: true,
        associatedWaitpoint: { select: { id: true } },
        organizationId: true,
        projectId: true,
        runtimeEnvironmentId: true,
      },
    },
    readClient
  )) as Array<{ id: string; status: string; lockedAt: Date | null }>;

  const runsToExpire: typeof runs = [];
  for (const run of runs) {
    if (run.status !== "PENDING") {
      skipped.push({ runId: run.id, reason: `status_${run.status}` });
      continue;
    }
    if (run.lockedAt) {
      skipped.push({ runId: run.id, reason: "locked" });
      continue;
    }
    runsToExpire.push(run);
  }

  const foundRunIds = new Set(runs.map((r) => r.id));
  for (const runId of runIds) {
    if (!foundRunIds.has(runId)) {
      skipped.push({ runId, reason: "not_found" });
    }
  }

  // The rest of expireRunsBatch would write EXPIRED + emit runExpired for runsToExpire only.
  for (const run of runsToExpire) {
    expired.push(run.id);
  }

  return { expired, skipped };
}

describe("run-ops split — TTL batch expiry guard threads the owning primary; the client-less path orphans the run", () => {
  // A LEGACY-resident (cuid) run sits PENDING on the control-plane WRITER; the control-plane REPLICA
  // lags (its `taskRun` reads come back empty, as just after a very-short-TTL run is created). The
  // TTL Lua script has already dequeued the run, so this guard is its only chance to be expired.
  heteroRunOpsPostgresTest(
    "LEGACY cuid: primary-threaded guard expires the run; the client-less control path misses it on the lagging replica -> orphaned as not_found",
    async ({ prisma14, prisma17 }) => {
      // Control-plane replica lags on `taskRun`: the just-created run row is not visible yet.
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

      const seed = await seedEnvironment(prisma14, "ttl_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_ttl_leg",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // Sanity: the run really is PENDING on the primary (so the only reason a guard could skip it is
      // the misrouted replica read, not a genuinely-missing/non-PENDING run).
      const onPrimary = await legacyStore.findRun({ id: runId }, prisma14);
      expect(onPrimary).not.toBeNull();
      expect(onPrimary!.status).toBe("PENDING");

      // Contrast — the read-your-writes path (thread the primary, as single-run expireRun does): the
      // run is found on the owning store's writer and IS expired. Establishes the run is genuinely
      // expirable, so any miss below is purely the misrouted read.
      const viaPrimary = await guardExpireBatch(router, [runId], prisma14);
      expect(viaPrimary.expired).toEqual([runId]);
      expect(viaPrimary.skipped).toEqual([]);

      // The client-less control path: findRuns with NO client → owning store's REPLICA.
      const guard = await guardExpireBatch(router, [runId]);

      // Proves the misrouted read is what happened: the (stale) legacy replica was consulted.
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      // The property the primary read secures: a client-less findRuns misses the run on the lagging
      // replica and buckets it `not_found`, so the run would be ORPHANED — never expired. Pinning it
      // here documents why expireRunsBatch threads this.$.prisma (the viaPrimary path above).
      expect(guard.expired).toEqual([]);
      expect(guard.skipped).toEqual([{ runId, reason: "not_found" }]);
    }
  );
});
