// RED→GREEN lock for RoutingRunStore.findRun's ON-MISS FAN-OUT for a CLASSIFIABLE id.
//
// THE BUG: findRun for a classifiable id routed to the SINGLE owning store (by id-shape
// classification) and returned whatever it gave — no on-miss fallback. When a run's PHYSICAL
// residency does not match its id-shape classification (e.g. a pre-#4154 27-char base62 run that
// lives on the NEW store but now classifies LEGACY), findRun routed to the wrong store, missed,
// and returned null → a spurious 404 — even though the run is physically present on the OTHER DB
// (and runs.list surfaces it). The unclassifiable path already fanned out NEW→LEGACY; this makes
// the classifiable path equally robust.
//
// Uses the REAL two-physical-DB split (heteroRunOpsPostgresTest: prisma14 = full/legacy on PG14,
// prisma17 = dedicated run-ops subset on PG17). NEVER mocked. The residency/classification MISMATCH
// is simulated deterministically by injecting a custom `classify` fn into the RoutingRunStore
// constructor — the physical row is written to the NEW store while `classify` reports its id LEGACY.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import { ownerEngine, type Residency } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput, RunStore } from "./types.js";

// ownerEngine classifies by internal-id LENGTH/version char: 25 chars → cuid → LEGACY,
// a v1 body (version "1" at index 25) → run-ops id → NEW.
function cuidLegacy(seed: string): string {
  return (seed + "c".repeat(25)).slice(0, 25);
}
function runOpsNew(seed: string): string {
  return (seed.replace(/[^0-9a-v]/g, "0") + "k".repeat(24)).slice(0, 24) + "01";
}

function makeDedicatedStore(prisma17: RunOpsPrismaClient) {
  return new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
}

function makeLegacyStore(prisma14: PrismaClient) {
  return new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
  });
}

// Wrap a real store so findRun/findRunOnPrimary calls are COUNTED while every method still delegates
// to the REAL PostgresRunStore (this is instrumentation, not a behavior mock — the underlying reads,
// writes, getters all run for real). Lets us assert the FAST PATH does not touch the other store.
function countingReads(
  inner: RunStore,
  counts: { findRun: number; findRunOnPrimary: number }
): RunStore {
  return new Proxy(inner, {
    get(target, prop) {
      // Read via target[prop] so getters (e.g. primaryReadClient) run with `this` = the real store.
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof value !== "function") return value;
      if (prop === "findRun" || prop === "findRunOnPrimary") {
        return (...args: unknown[]) => {
          counts[prop as "findRun" | "findRunOnPrimary"] += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as unknown as RunStore;
}

async function seedLegacyEnvironment(prisma14: PrismaClient, suffix: string) {
  const organization = await prisma14.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma14.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma14.runtimeEnvironment.create({
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
  return {
    organizationId: organization.id,
    projectId: project.id,
    runtimeEnvironmentId: environment.id,
    environmentId: environment.id,
  };
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
      payload: "{}",
      payloadType: "application/json",
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
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

// Insert a TaskRun row DIRECTLY onto the NEW (dedicated) store, bypassing routing, so we can force a
// residency/classification MISMATCH: the row is physically on #new while `classify` calls its id LEGACY.
async function insertRunOnNewStore(
  prisma17: RunOpsPrismaClient,
  params: {
    runId: string;
    friendlyId: string;
    environmentId: string;
    organizationId: string;
    projectId: string;
  }
) {
  await prisma17.taskRun.create({
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.environmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
    },
  });
}

describe("RoutingRunStore.findRun — on-miss fan-out for a classifiable id (residency ≠ classification)", () => {
  // ── THE BUG: a run physically on #new whose id classifies LEGACY must still be found ──
  // Without the on-miss fallback, findRun routes to #legacy (per classification), misses, returns null.
  heteroRunOpsPostgresTest(
    "returns a #new-resident run whose id classifies LEGACY (owning-store miss → other-store fallback)",
    async ({ prisma14, prisma17 }) => {
      const env = await seedLegacyEnvironment(prisma14, "mm1");
      const newStore = makeDedicatedStore(prisma17);
      const legacyStore = makeLegacyStore(prisma14);

      // A run-ops-shaped id (so ownerEngine would say NEW), but we FORCE classify → LEGACY to model
      // a residency/classification mismatch: physically on #new, classified LEGACY.
      const mismatchId = runOpsNew("mm1");
      const classify = (id: string): Residency => (id === mismatchId ? "LEGACY" : ownerEngine(id));
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore, classify });

      await insertRunOnNewStore(prisma17, {
        runId: mismatchId,
        friendlyId: "run_mm1",
        environmentId: env.environmentId,
        organizationId: env.organizationId,
        projectId: env.projectId,
      });

      // Physical residency sanity: on #new only.
      expect(await prisma17.taskRun.findUnique({ where: { id: mismatchId } })).not.toBeNull();
      expect(await prisma14.taskRun.findUnique({ where: { id: mismatchId } })).toBeNull();

      // classify → LEGACY routes to #legacy (miss); the fix falls back to #new and finds the run.
      const byId = (await router.findRun({ id: mismatchId }, { select: { id: true } })) as Record<
        string,
        unknown
      > | null;
      expect(byId?.id).toBe(mismatchId);

      // Same on the read-your-writes primary variant (a caller-passed writer → findRunOnPrimary).
      const byIdPrimary = (await router.findRun(
        { id: mismatchId },
        { select: { id: true } },
        prisma14
      )) as Record<string, unknown> | null;
      expect(byIdPrimary?.id).toBe(mismatchId);
    }
  );

  // ── FAST PATH: a run found in its CLASSIFIED store is a SINGLE read (no second-store probe) ──
  heteroRunOpsPostgresTest(
    "does NOT read the other store when the classified (owning) store hits",
    async ({ prisma14, prisma17 }) => {
      const env = await seedLegacyEnvironment(prisma14, "mm2");

      // NEW-resident run-ops-id run: owning store = #new. Wrap #legacy to catch any stray probe.
      const newCounts = { findRun: 0, findRunOnPrimary: 0 };
      const legacyCounts = { findRun: 0, findRunOnPrimary: 0 };
      const newStore = countingReads(makeDedicatedStore(prisma17), newCounts);
      const legacyStore = countingReads(makeLegacyStore(prisma14), legacyCounts);
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const newId = runOpsNew("mm2n"); // classifies NEW
      await router.createRun(
        buildCreateRunInput({
          runId: newId,
          friendlyId: "run_mm2_new",
          organizationId: env.organizationId,
          projectId: env.projectId,
          runtimeEnvironmentId: env.runtimeEnvironmentId,
        })
      );

      const hit = (await router.findRun({ id: newId }, { select: { id: true } })) as Record<
        string,
        unknown
      > | null;
      expect(hit?.id).toBe(newId);
      // Owning store read exactly once; the other store NOT touched (fast path preserved).
      expect(newCounts.findRun).toBe(1);
      expect(legacyCounts.findRun).toBe(0);
      expect(legacyCounts.findRunOnPrimary).toBe(0);

      // Symmetric: a cuid run whose owning store is #legacy must not probe #new on a hit.
      const legacyId = cuidLegacy("mm2l"); // classifies LEGACY
      await router.createRun(
        buildCreateRunInput({
          runId: legacyId,
          friendlyId: "run_mm2_legacy",
          organizationId: env.organizationId,
          projectId: env.projectId,
          runtimeEnvironmentId: env.runtimeEnvironmentId,
        })
      );
      newCounts.findRun = 0;
      legacyCounts.findRun = 0;

      const hitLegacy = (await router.findRun(
        { id: legacyId },
        { select: { id: true } }
      )) as Record<string, unknown> | null;
      expect(hitLegacy?.id).toBe(legacyId);
      expect(legacyCounts.findRun).toBe(1);
      expect(newCounts.findRun).toBe(0);
    }
  );

  // ── A genuine miss on BOTH stores still returns null (fan-out exhausted) ──
  heteroRunOpsPostgresTest(
    "returns null when the run is on neither store",
    async ({ prisma14, prisma17 }) => {
      const newStore = makeDedicatedStore(prisma17);
      const legacyStore = makeLegacyStore(prisma14);
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      expect(
        await router.findRun({ id: cuidLegacy("ghost") }, { select: { id: true } })
      ).toBeNull();
    }
  );
});
