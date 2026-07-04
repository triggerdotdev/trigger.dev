// MIXED-RESIDENCY MATRIX — systematic LOCK that every RoutingRunStore fan-out / partition / merge /
// dedup method behaves correctly when cuid (#legacy) AND run-ops id (#new) data COEXIST in the SAME call,
// against the REAL two-physical-DB split (heteroRunOpsPostgresTest: prisma14 = full/legacy on PG14,
// prisma17 = RunOpsPrismaClient / dedicated subset on PG17). NEVER mocked.
//
// Existing tests exercise these methods one residency at a time or for a single specific bug. This
// file is the cross-residency matrix: each case seeds BOTH a cuid row on #legacy AND a run-ops id row on
// #new in one environment, then drives the wired router and asserts the merge/partition is correct.
// The matrix MUST go RED if a fan-out leg is dropped or a NEW-wins dedup regresses (see the reverted
// mutation probes recorded in the task report).

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput, RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies by internal-id LENGTH after stripping a leading `<prefix>_`
// (runOpsResidency.ts): 25 chars (no internal underscore) → cuid → LEGACY, a v1 body (version "1" at index 25) → run-ops id → NEW.
// These mint a distinct classifiable id of the right length from a short seed.
function cuidLegacy(seed: string): string {
  return (seed + "c".repeat(25)).slice(0, 25); // 25 chars → LEGACY (#legacy / prisma14)
}
function runOpsNew(seed: string): string {
  return (seed.replace(/[^0-9a-v]/g, "0") + "k".repeat(24)).slice(0, 24) + "01";
}

// On the dedicated subset there are no Organization/Project/RuntimeEnvironment models (run-ops rows
// carry FK-free scalar ids), so mint synthetic owning ids. On legacy seed the real rows the kept FKs
// require.
async function seedEnvironment(
  prisma: AnyClient,
  schemaVariant: RunStoreSchemaVariant,
  suffix: string
) {
  if (schemaVariant === "dedicated") {
    return {
      organization: { id: `org_${suffix}` },
      project: { id: `proj_${suffix}` },
      environment: { id: `env_${suffix}` },
    };
  }
  const organization = await (prisma as PrismaClient).organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await (prisma as PrismaClient).project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await (prisma as PrismaClient).runtimeEnvironment.create({
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
  taskIdentifier?: string;
  status?: "PENDING" | "EXECUTING";
  spanId?: string;
  batchId?: string;
  createdAt?: Date;
  idempotencyKey?: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: params.status ?? "PENDING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: params.taskIdentifier ?? "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: `trace_${params.runId}`,
      spanId: params.spanId ?? `span_${params.runId}`,
      runTags: [],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: params.createdAt ?? new Date("2024-01-01T00:00:00.000Z"),
      ...(params.batchId && { batchId: params.batchId }),
      ...(params.idempotencyKey && {
        idempotencyKey: params.idempotencyKey,
        idempotencyKeyExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: params.status ?? "PENDING",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

async function seedPendingWaitpoint(
  prisma: AnyClient,
  params: {
    id: string;
    friendlyId: string;
    projectId: string;
    environmentId: string;
    type?: "MANUAL" | "RUN" | "DATETIME";
    status?: "PENDING" | "COMPLETED";
    completedByTaskRunId?: string;
    completedByBatchId?: string;
  }
) {
  return (prisma as PrismaClient).waitpoint.create({
    data: {
      id: params.id,
      friendlyId: params.friendlyId,
      type: params.type ?? "MANUAL",
      status: params.status ?? "PENDING",
      idempotencyKey: `idem_${params.id}`,
      userProvidedIdempotencyKey: false,
      projectId: params.projectId,
      environmentId: params.environmentId,
      ...(params.completedByTaskRunId && { completedByTaskRunId: params.completedByTaskRunId }),
      ...(params.completedByBatchId && { completedByBatchId: params.completedByBatchId }),
    },
  });
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

// The REAL production split topology: #new = dedicated subset on prisma17, #legacy = full schema on
// prisma14. Two physically-distinct DBs, dedicated subset schema on #new.
function makeSplitRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyStore = makeLegacyStore(prisma14);
  const newStore = makeDedicatedStore(prisma17);
  return {
    router: new RoutingRunStore({ new: newStore, legacy: legacyStore }),
    legacyStore,
    newStore,
  };
}

// Seed ONE logical environment whose scalar env/project/org ids are shared by both physical DBs (the
// run-ops scalar ids are identical on each), with real owning rows on #legacy and synthetic ids on
// #new. Returns the shared scalar ids used by every mixed-residency seed.
async function seedSharedEnv(prisma14: PrismaClient, suffix: string) {
  const legacy = await seedEnvironment(prisma14, "legacy", suffix);
  return {
    organizationId: legacy.organization.id,
    projectId: legacy.project.id,
    runtimeEnvironmentId: legacy.environment.id,
    environmentId: legacy.environment.id,
  };
}

describe("RoutingRunStore — mixed-residency matrix (cuid #legacy + run-ops id #new coexisting)", () => {
  // ── Case 1: findRuns by a MIXED bounded id-set (#findRunsByIdSet, runOpsStore.ts:294) ──
  // A list-hydrate id set spans cuid (legacy) + run-ops id (new) ids plus a run-ops id absent from legacy.
  // Both resident runs returned; take/skip applied GLOBALLY post-merge; orderBy honored; the absent
  // run-ops id short-circuits (never probed on LEGACY, :309).
  heteroRunOpsPostgresTest(
    "case 1: findRuns by a mixed id-set returns both DBs' runs, ordered, take/skip global",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m1");

      const legacyId = cuidLegacy("m1l"); // cuid → #legacy
      const newId = runOpsNew("m1n"); // run-ops id → #new
      const ghostRunOpsId = runOpsNew("m1g"); // run-ops id, NEVER created → tests the LEGACY short-circuit

      await router.createRun(
        buildCreateRunInput({
          runId: legacyId,
          friendlyId: "run_m1_legacy",
          createdAt: new Date("2024-01-02T00:00:00.000Z"),
          ...env,
        })
      );
      await router.createRun(
        buildCreateRunInput({
          runId: newId,
          friendlyId: "run_m1_new",
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
          ...env,
        })
      );

      // Physical residency sanity: each landed on its own DB only.
      expect(await prisma14.taskRun.findUnique({ where: { id: legacyId } })).not.toBeNull();
      expect(await prisma17.taskRun.findUnique({ where: { id: legacyId } })).toBeNull();
      expect(await prisma17.taskRun.findUnique({ where: { id: newId } })).not.toBeNull();
      expect(await prisma14.taskRun.findUnique({ where: { id: newId } })).toBeNull();

      // Full merge, ordered by createdAt asc → newId (Jan 1) before legacyId (Jan 2).
      const all = await router.findRuns({
        where: { id: { in: [legacyId, newId, ghostRunOpsId] } },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      expect(all.map((r) => r.id)).toEqual([newId, legacyId]);

      // take=1 after the merge → only the first (newId). Proves take is applied GLOBALLY, not per-leg
      // (a per-leg take=1 would return one row from EACH DB → both ids).
      const firstOnly = await router.findRuns({
        where: { id: { in: [legacyId, newId, ghostRunOpsId] } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      });
      expect(firstOnly.map((r) => r.id)).toEqual([newId]);

      // skip=1 take=1 → the second (legacyId).
      const second = await router.findRuns({
        where: { id: { in: [legacyId, newId, ghostRunOpsId] } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        skip: 1,
        take: 1,
      });
      expect(second.map((r) => r.id)).toEqual([legacyId]);
    }
  );

  // ── Case 1b: NEW-wins on id collision in #findRunsByIdSet ──
  // The copy→fence window can leave the same id on both DBs. The id-set path queries NEW first; an id
  // already found on NEW must NOT be re-fetched from LEGACY, so the NEW copy wins.
  heteroRunOpsPostgresTest(
    "case 1b: findRuns by id-set with a colliding id resolves to the NEW copy",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m1b");

      // A cuid id (LEGACY id-shape) that exists on BOTH DBs with a distinguishing field.
      const collidingId = cuidLegacy("m1b");
      await router.createRun(
        buildCreateRunInput({ runId: collidingId, friendlyId: "run_m1b_legacy", ...env })
      ); // → #legacy (cuid)
      // Force the same id onto #new with a different taskIdentifier so we can tell the copies apart.
      await prisma17.taskRun.create({
        data: {
          id: collidingId,
          engine: "V2",
          status: "PENDING",
          friendlyId: "run_m1b_new",
          runtimeEnvironmentId: env.environmentId,
          environmentType: "DEVELOPMENT",
          organizationId: env.organizationId,
          projectId: env.projectId,
          taskIdentifier: "new-copy-wins",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: "t",
          spanId: "s",
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
        },
      });

      const rows = await router.findRuns({
        where: { id: { in: [collidingId] } },
        select: { id: true, taskIdentifier: true },
      });
      expect(rows).toHaveLength(1); // deduped, not double-reported
      expect((rows[0] as any).taskIdentifier).toBe("new-copy-wins"); // NEW wins
    }
  );

  // ── Case 2: findRuns by an OPEN predicate (#findRunsOpen, runOpsStore.ts:319) ──
  // No id set → query BOTH stores, union, dedup by id (NEW wins). Filter by a shared scalar
  // (runtimeEnvironmentId + status) that matches rows on both DBs.
  heteroRunOpsPostgresTest(
    "case 2: findRuns by an open predicate unions rows from both DBs (NEW-wins dedup)",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m2");

      const legacyId = cuidLegacy("m2l");
      const newId = runOpsNew("m2n");
      await router.createRun(
        buildCreateRunInput({
          runId: legacyId,
          friendlyId: "run_m2_legacy",
          status: "EXECUTING",
          ...env,
        })
      );
      await router.createRun(
        buildCreateRunInput({ runId: newId, friendlyId: "run_m2_new", status: "EXECUTING", ...env })
      );
      // A PENDING run on each DB that must be FILTERED OUT by the status predicate.
      await router.createRun(
        buildCreateRunInput({
          runId: cuidLegacy("m2lp"),
          friendlyId: "run_m2_legacy_pending",
          status: "PENDING",
          ...env,
        })
      );
      await router.createRun(
        buildCreateRunInput({
          runId: runOpsNew("m2np"),
          friendlyId: "run_m2_new_pending",
          status: "PENDING",
          ...env,
        })
      );

      const executing = await router.findRuns({
        where: { runtimeEnvironmentId: env.environmentId, status: "EXECUTING" },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      expect(executing.map((r) => r.id).sort()).toEqual([legacyId, newId].sort());
    }
  );

  // ── Case 3: expireRunsBatch with a MIXED id list (runOpsStore.ts:474) ──
  // Partitions run-ops id→NEW / cuid→LEGACY; each leg called only when non-empty; counts summed; each row
  // updated on its OWN DB only.
  heteroRunOpsPostgresTest(
    "case 3: expireRunsBatch partitions a mixed id list per-DB and sums the count",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m3");

      const legacyId = cuidLegacy("m3l");
      const newId = runOpsNew("m3n");
      await router.createRun(
        buildCreateRunInput({ runId: legacyId, friendlyId: "run_m3_legacy", ...env })
      );
      await router.createRun(
        buildCreateRunInput({ runId: newId, friendlyId: "run_m3_new", ...env })
      );

      const now = new Date("2024-03-03T00:00:00.000Z");
      const count = await router.expireRunsBatch([legacyId, newId], {
        error: { type: "STRING_ERROR", raw: "expired" },
        now,
      });
      expect(count).toBe(2); // one updated on each DB, summed

      // Each row is EXPIRED on its OWN DB only.
      expect((await prisma14.taskRun.findUnique({ where: { id: legacyId } }))?.status).toBe(
        "EXPIRED"
      );
      expect((await prisma17.taskRun.findUnique({ where: { id: newId } }))?.status).toBe("EXPIRED");
    }
  );

  // ── Case 4: clearIdempotencyKey fan-out arm (byFriendlyIds, runOpsStore.ts:358) ──
  // byFriendlyIds spans mixed residency → fan out to both, sum the count, each row cleared on its home.
  heteroRunOpsPostgresTest(
    "case 4: clearIdempotencyKey byFriendlyIds clears across both DBs and sums the count",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m4");

      const legacyId = cuidLegacy("m4l");
      const newId = runOpsNew("m4n");
      await router.createRun(
        buildCreateRunInput({
          runId: legacyId,
          friendlyId: "run_m4_legacy",
          idempotencyKey: "m4-key-legacy",
          ...env,
        })
      );
      await router.createRun(
        buildCreateRunInput({
          runId: newId,
          friendlyId: "run_m4_new",
          idempotencyKey: "m4-key-new",
          ...env,
        })
      );

      const { count } = await router.clearIdempotencyKey({
        byFriendlyIds: ["run_m4_legacy", "run_m4_new"],
      });
      expect(count).toBe(2); // one cleared on each DB, summed

      expect((await prisma14.taskRun.findUnique({ where: { id: legacyId } }))?.idempotencyKey).toBe(
        null
      );
      expect((await prisma17.taskRun.findUnique({ where: { id: newId } }))?.idempotencyKey).toBe(
        null
      );
    }
  );

  // ── Case 5: countPendingWaitpoints scattered across both DBs (runOpsStore.ts:731) ──
  // A run's pending waitpoints can be split across both stores mid-drain → count on each and sum.
  heteroRunOpsPostgresTest(
    "case 5: countPendingWaitpoints sums PENDING waitpoints scattered across both DBs",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m5");

      const legacyWp = cuidLegacy("m5l"); // PENDING on #legacy
      const newWp = runOpsNew("m5n"); // PENDING on #new
      const completedWp = runOpsNew("m5c"); // COMPLETED on #new → must NOT be counted
      await seedPendingWaitpoint(prisma14, {
        id: legacyWp,
        friendlyId: "wp_m5_legacy",
        projectId: env.projectId,
        environmentId: env.environmentId,
      });
      await seedPendingWaitpoint(prisma17, {
        id: newWp,
        friendlyId: "wp_m5_new",
        projectId: env.projectId,
        environmentId: env.environmentId,
      });
      await seedPendingWaitpoint(prisma17, {
        id: completedWp,
        friendlyId: "wp_m5_completed",
        projectId: env.projectId,
        environmentId: env.environmentId,
        status: "COMPLETED",
      });

      // Both PENDING ones counted (one per DB); the COMPLETED one excluded.
      expect(await router.countPendingWaitpoints([legacyWp, newWp, completedWp])).toBe(2);
    }
  );

  // ── Case 6: findManyWaitpoints { id: { in: [...mixed...] } } (runOpsStore.ts:793) ──
  // Merge waitpoints from both DBs for a mixed id set.
  heteroRunOpsPostgresTest(
    "case 6: findManyWaitpoints merges a mixed id set from both DBs",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m6");

      const legacyWp = cuidLegacy("m6l");
      const newWp = runOpsNew("m6n");
      await seedPendingWaitpoint(prisma14, {
        id: legacyWp,
        friendlyId: "wp_m6_legacy",
        projectId: env.projectId,
        environmentId: env.environmentId,
      });
      await seedPendingWaitpoint(prisma17, {
        id: newWp,
        friendlyId: "wp_m6_new",
        projectId: env.projectId,
        environmentId: env.environmentId,
      });

      const found = await router.findManyWaitpoints({ where: { id: { in: [legacyWp, newWp] } } });
      expect(found.map((w) => w.id).sort()).toEqual([legacyWp, newWp].sort());
    }
  );

  // ── Case 8: findExecutionSnapshot / findManyExecutionSnapshots OPEN (no runId) where ──
  // A by-snapshot-id-only lookup (snapshot ids are non-classifiable cuids) must fan out NEW→LEGACY
  // (findExecutionSnapshot, :675) / merge both (findManyExecutionSnapshots, :688). Seed a snapshot on
  // EACH DB (one run-ops run on #new, one cuid run on #legacy) and read with a no-runId where.
  heteroRunOpsPostgresTest(
    "case 8: findExecutionSnapshot/findManyExecutionSnapshots with an open where reach both DBs",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m8");

      const legacyRun = cuidLegacy("m8l");
      const newRun = runOpsNew("m8n");
      await router.createRun(
        buildCreateRunInput({ runId: legacyRun, friendlyId: "run_m8_legacy", ...env })
      );
      await router.createRun(
        buildCreateRunInput({ runId: newRun, friendlyId: "run_m8_new", ...env })
      );

      const snapEnv = {
        environmentId: env.environmentId,
        environmentType: "DEVELOPMENT" as const,
        projectId: env.projectId,
        organizationId: env.organizationId,
      };
      const legacySnap = await router.createExecutionSnapshot({
        run: { id: legacyRun, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "m8 legacy snap" },
        ...snapEnv,
      });
      const newSnap = await router.createExecutionSnapshot({
        run: { id: newRun, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "m8 new snap" },
        ...snapEnv,
      });

      // findExecutionSnapshot with a no-runId where targeting the LEGACY snapshot id: NEW miss → LEGACY hit.
      const foundLegacy = await router.findExecutionSnapshot({ where: { id: legacySnap.id } });
      expect(foundLegacy?.id).toBe(legacySnap.id);
      // And the NEW snapshot id resolves on the NEW leg.
      const foundNew = await router.findExecutionSnapshot({ where: { id: newSnap.id } });
      expect(foundNew?.id).toBe(newSnap.id);

      // findManyExecutionSnapshots open where (both ids) merges both DBs.
      const many = await router.findManyExecutionSnapshots({
        where: { id: { in: [legacySnap.id, newSnap.id] } },
      });
      expect(many.map((s) => s.id).sort()).toEqual([legacySnap.id, newSnap.id].sort());
    }
  );

  // ── Case 9a: findRun with an UNCLASSIFIABLE where (spanId) on a #legacy run (#findRunUnrouted, :213) ──
  // A run-ops run on #new and a cuid run on #legacy each carry a distinct spanId. A spanId where can't
  // be id-classified → fan out NEW-first then LEGACY. The legacy-resident run must be found.
  heteroRunOpsPostgresTest(
    "case 9a: findRun by spanId fans out and finds a #legacy run (NEW miss → LEGACY hit)",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m9a");

      const legacyRun = cuidLegacy("m9al");
      const newRun = runOpsNew("m9an");
      await router.createRun(
        buildCreateRunInput({
          runId: legacyRun,
          friendlyId: "run_m9a_legacy",
          spanId: "span_m9a_legacy",
          ...env,
        })
      );
      await router.createRun(
        buildCreateRunInput({
          runId: newRun,
          friendlyId: "run_m9a_new",
          spanId: "span_m9a_new",
          ...env,
        })
      );

      const onLegacy = (await router.findRun(
        { spanId: "span_m9a_legacy" },
        { select: { id: true } }
      )) as Record<string, any> | null;
      expect(onLegacy?.id).toBe(legacyRun);

      const onNew = (await router.findRun(
        { spanId: "span_m9a_new" },
        { select: { id: true } }
      )) as Record<string, any> | null;
      expect(onNew?.id).toBe(newRun);
    }
  );

  // ── Case 9b: findRunOrThrow with an UNCLASSIFIABLE where (spanId) on a #legacy run (:593) ──
  // The throwing twin must match findRun's fan-out: an unclassifiable where whose only matching run
  // lives on #legacy must NOT throw. A NEW-only fallback would miss the legacy run and throw.
  heteroRunOpsPostgresTest(
    "case 9b: findRunOrThrow by spanId fans out and finds a #legacy run without throwing",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m9b");

      const legacyRun = cuidLegacy("m9bl");
      const newRun = runOpsNew("m9bn");
      await router.createRun(
        buildCreateRunInput({
          runId: legacyRun,
          friendlyId: "run_m9b_legacy",
          spanId: "span_m9b_legacy",
          ...env,
        })
      );
      await router.createRun(
        buildCreateRunInput({
          runId: newRun,
          friendlyId: "run_m9b_new",
          spanId: "span_m9b_new",
          ...env,
        })
      );

      const onLegacy = (await router.findRunOrThrow(
        { spanId: "span_m9b_legacy" },
        { select: { id: true } }
      )) as Record<string, any>;
      expect(onLegacy.id).toBe(legacyRun);

      const onNew = (await router.findRunOrThrow(
        { spanId: "span_m9b_new" },
        { select: { id: true } }
      )) as Record<string, any>;
      expect(onNew.id).toBe(newRun);
    }
  );

  // ── Case 7: findManyTaskRunWaitpoints with edges whose relations STRADDLE DBs (runOpsStore.ts:876) ──
  // An edge co-locates with its RUN, but its `waitpoint`/`taskRun` relations can live on the OTHER DB
  // (a cuid token blocking a run-ops run, and vice versa). The per-leg scalar query is stripped of the
  // relation keys; the router re-hydrates `waitpoint`/`taskRun` across BOTH DBs. Exercises BOTH
  // straddle directions in one read by querying both edges via { taskRunId: { in } }.
  heteroRunOpsPostgresTest(
    "case 7: findManyTaskRunWaitpoints rehydrates waitpoint/taskRun relations across both DBs (both straddle directions)",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m7");

      // Direction A: run-ops run on #new, blocked on a cuid token that lives ONLY on #legacy. Edge on #new.
      const newRun = runOpsNew("m7nr");
      const legacyToken = cuidLegacy("m7lt");
      await router.createRun(
        buildCreateRunInput({ runId: newRun, friendlyId: "run_m7_new", ...env })
      );
      await seedPendingWaitpoint(prisma14, {
        id: legacyToken,
        friendlyId: "wp_m7_legacy_token",
        projectId: env.projectId,
        environmentId: env.environmentId,
      });
      // Write the edge on #new (the run's DB) directly — the cuid token is absent from #new, so the
      // edge's `waitpoint` must be re-hydrated from #legacy.
      await prisma17.$executeRawUnsafe(
        `INSERT INTO "TaskRunWaitpoint" ("id","taskRunId","waitpointId","projectId","createdAt","updatedAt") VALUES (gen_random_uuid(),'${newRun}','${legacyToken}','${env.projectId}',NOW(),NOW())`
      );

      // Direction B: cuid run on #legacy, blocked on a run-ops token mirrored onto BOTH DBs (drain
      // window). The #legacy copy is a STALE placeholder (PENDING) that satisfies the legacy edge FK;
      // the AUTHORITATIVE #new copy is COMPLETED. Edge on #legacy. Hydration re-resolves cross-DB and
      // NEW-wins the dedup → the edge's waitpoint must read the #new (COMPLETED) copy, not the local mirror.
      const legacyRun = cuidLegacy("m7lr");
      const newToken = runOpsNew("m7nt");
      await router.createRun(
        buildCreateRunInput({ runId: legacyRun, friendlyId: "run_m7_legacy", ...env })
      );
      await seedPendingWaitpoint(prisma14, {
        id: newToken,
        friendlyId: "wp_m7_legacy_mirror",
        projectId: env.projectId,
        environmentId: env.environmentId,
        status: "PENDING",
      });
      await seedPendingWaitpoint(prisma17, {
        id: newToken,
        friendlyId: "wp_m7_new_token",
        projectId: env.projectId,
        environmentId: env.environmentId,
        status: "COMPLETED",
      });
      await prisma14.$executeRawUnsafe(
        `INSERT INTO "TaskRunWaitpoint" ("id","taskRunId","waitpointId","projectId","createdAt","updatedAt") VALUES (gen_random_uuid(),'${legacyRun}','${newToken}','${env.projectId}',NOW(),NOW())`
      );

      // Edges sanity: each edge lives on its run's DB only.
      expect(await prisma17.taskRunWaitpoint.count({ where: { taskRunId: newRun } })).toBe(1);
      expect(await prisma14.taskRunWaitpoint.count({ where: { taskRunId: newRun } })).toBe(0);
      expect(await prisma14.taskRunWaitpoint.count({ where: { taskRunId: legacyRun } })).toBe(1);
      expect(await prisma17.taskRunWaitpoint.count({ where: { taskRunId: legacyRun } })).toBe(0);

      // One read spanning both runs: both edges returned (deduped by id), and each edge's `waitpoint`
      // + `taskRun` re-hydrated from whichever DB holds them.
      const edges = (await router.findManyTaskRunWaitpoints({
        where: { taskRunId: { in: [newRun, legacyRun] } },
        select: {
          id: true,
          taskRunId: true,
          waitpointId: true,
          waitpoint: { select: { id: true, status: true } },
          taskRun: { select: { id: true } },
        },
      })) as Array<Record<string, any>>;

      expect(edges).toHaveLength(2);
      const byRun = new Map(edges.map((e) => [e.taskRunId as string, e]));

      // Direction A edge: waitpoint hydrated from #legacy (cuid token), taskRun is the #new run.
      const aEdge = byRun.get(newRun)!;
      expect(aEdge.waitpoint?.id).toBe(legacyToken);
      expect(aEdge.waitpoint?.status).toBe("PENDING");
      expect(aEdge.taskRun?.id).toBe(newRun);

      // Direction B edge: waitpoint hydrated from the AUTHORITATIVE #new copy (COMPLETED), proving the
      // relation was re-resolved cross-DB and NEW won the dedup over the stale local #legacy mirror.
      const bEdge = byRun.get(legacyRun)!;
      expect(bEdge.waitpoint?.id).toBe(newToken);
      expect(bEdge.waitpoint?.status).toBe("COMPLETED");
      expect(bEdge.taskRun?.id).toBe(legacyRun);
    }
  );

  // ── Case 7b: the "blocking waitpoint not found on either DB" HARD ERROR (runOpsStore.ts:917) ──
  // An edge whose `waitpointId` resolves on NEITHER DB must throw rather than leave a null status that
  // would strand (hang) or wrongly unblock the run.
  heteroRunOpsPostgresTest(
    "case 7b: findManyTaskRunWaitpoints throws when a blocking waitpoint is on neither DB",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m7b");

      const newRun = runOpsNew("m7br");
      const ghostToken = runOpsNew("m7bg"); // never created on either DB
      await router.createRun(
        buildCreateRunInput({ runId: newRun, friendlyId: "run_m7b_new", ...env })
      );
      await prisma17.$executeRawUnsafe(
        `INSERT INTO "TaskRunWaitpoint" ("id","taskRunId","waitpointId","projectId","createdAt","updatedAt") VALUES (gen_random_uuid(),'${newRun}','${ghostToken}','${env.projectId}',NOW(),NOW())`
      );

      await expect(
        router.findManyTaskRunWaitpoints({
          where: { taskRunId: newRun },
          select: { id: true, waitpointId: true, waitpoint: { select: { status: true } } },
        })
      ).rejects.toThrow(/not found on either run-ops DB/);
    }
  );

  // ── Case 10: findBatchTaskRunById / findBatchTaskRunByFriendlyId NEW-then-LEGACY probe (:1124,:1137) ──
  // A batch resident on #legacy AND a run-ops-id batch landed on #new (the control-plane window mints
  // cuid ids, but a run-ops batch resides on #new) are BOTH found via the probe, regardless of id-shape.
  heteroRunOpsPostgresTest(
    "case 10: findBatchTaskRunById/byFriendlyId probe NEW then LEGACY and find batches on either DB",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m10");

      const legacyBatch = cuidLegacy("m10l"); // cuid → #legacy
      const newBatch = runOpsNew("m10n"); // run-ops id → #new
      await prisma14.batchTaskRun.create({
        data: {
          id: legacyBatch,
          friendlyId: "batch_m10_legacy",
          runtimeEnvironmentId: env.environmentId,
          runCount: 1,
          status: "PROCESSING",
        },
      });
      await prisma17.batchTaskRun.create({
        data: {
          id: newBatch,
          friendlyId: "batch_m10_new",
          runtimeEnvironmentId: env.environmentId,
          runCount: 1,
          status: "PROCESSING",
        },
      });

      // by id: each found on its own DB via the NEW-then-LEGACY probe.
      expect((await router.findBatchTaskRunById(legacyBatch))?.id).toBe(legacyBatch);
      expect((await router.findBatchTaskRunById(newBatch))?.id).toBe(newBatch);

      // by friendlyId (env-scoped): same probe order, both resolved.
      expect(
        (await router.findBatchTaskRunByFriendlyId("batch_m10_legacy", env.environmentId))?.id
      ).toBe(legacyBatch);
      expect(
        (await router.findBatchTaskRunByFriendlyId("batch_m10_new", env.environmentId))?.id
      ).toBe(newBatch);
    }
  );

  // ── Case 11a: updateManyWaitpoints with a NO-ID (batch) where fans out to both and sums (:822) ──
  // A batch where (no single routable id, e.g. completedByTaskRunId IS NULL + status PENDING) must
  // apply on BOTH DBs and sum the count.
  heteroRunOpsPostgresTest(
    "case 11a: updateManyWaitpoints with a no-id where updates both DBs and sums the count",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m11a");

      const legacyWp = cuidLegacy("m11al");
      const newWp = runOpsNew("m11an");
      await seedPendingWaitpoint(prisma14, {
        id: legacyWp,
        friendlyId: "wp_m11a_legacy",
        projectId: env.projectId,
        environmentId: env.environmentId,
      });
      await seedPendingWaitpoint(prisma17, {
        id: newWp,
        friendlyId: "wp_m11a_new",
        projectId: env.projectId,
        environmentId: env.environmentId,
      });

      const { count } = await router.updateManyWaitpoints({
        where: { status: "PENDING", projectId: env.projectId },
        data: { status: "COMPLETED" },
      });
      expect(count).toBe(2); // one per DB, summed

      expect((await prisma14.waitpoint.findUnique({ where: { id: legacyWp } }))?.status).toBe(
        "COMPLETED"
      );
      expect((await prisma17.waitpoint.findUnique({ where: { id: newWp } }))?.status).toBe(
        "COMPLETED"
      );
    }
  );

  // ── Case 11b: deleteManyTaskRunWaitpoints by taskRunId fans out to both and sums (:944) ──
  // A run's edges can straddle DBs mid-drain; a delete keyed by taskRunId (not waitpointId) must
  // delete from BOTH DBs and sum the count.
  heteroRunOpsPostgresTest(
    "case 11b: deleteManyTaskRunWaitpoints by taskRunId deletes edges on both DBs and sums",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "m11b");

      // ONE logical run id whose edges happen to exist on BOTH DBs (the straddle the fan-out guards).
      // The edge is FK-free on #new (unnest path) and FK-bound on #legacy, so seed a co-resident
      // waitpoint + run on #legacy for its edge, and write the #new edge directly.
      const runId = runOpsNew("m11br");
      const legacyToken = cuidLegacy("m11bt");
      await router.createRun(buildCreateRunInput({ runId, friendlyId: "run_m11b", ...env }));
      // #legacy needs the run + token present for the FK-bound edge insert.
      await prisma14.taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "PENDING",
          friendlyId: "run_m11b_legacy_mirror",
          runtimeEnvironmentId: env.environmentId,
          environmentType: "DEVELOPMENT",
          organizationId: env.organizationId,
          projectId: env.projectId,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: "t",
          spanId: "s_m11b",
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
        },
      });
      await seedPendingWaitpoint(prisma14, {
        id: legacyToken,
        friendlyId: "wp_m11b_legacy",
        projectId: env.projectId,
        environmentId: env.environmentId,
      });
      await prisma14.$executeRawUnsafe(
        `INSERT INTO "TaskRunWaitpoint" ("id","taskRunId","waitpointId","projectId","createdAt","updatedAt") VALUES (gen_random_uuid(),'${runId}','${legacyToken}','${env.projectId}',NOW(),NOW())`
      );
      // #new edge (FK-free) pointing at a run-ops token absent locally — drain straddle.
      const newToken = runOpsNew("m11bn");
      await prisma17.$executeRawUnsafe(
        `INSERT INTO "TaskRunWaitpoint" ("id","taskRunId","waitpointId","projectId","createdAt","updatedAt") VALUES (gen_random_uuid(),'${runId}','${newToken}','${env.projectId}',NOW(),NOW())`
      );

      expect(await prisma14.taskRunWaitpoint.count({ where: { taskRunId: runId } })).toBe(1);
      expect(await prisma17.taskRunWaitpoint.count({ where: { taskRunId: runId } })).toBe(1);

      const { count } = await router.deleteManyTaskRunWaitpoints({ where: { taskRunId: runId } });
      expect(count).toBe(2); // one edge deleted on each DB, summed

      expect(await prisma14.taskRunWaitpoint.count({ where: { taskRunId: runId } })).toBe(0);
      expect(await prisma17.taskRunWaitpoint.count({ where: { taskRunId: runId } })).toBe(0);
    }
  );
});
