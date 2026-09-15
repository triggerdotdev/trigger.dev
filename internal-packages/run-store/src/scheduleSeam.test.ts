// SCHEDULES over the run-ops cutover SEAM.
//
// schedule-engine (internal-packages/schedule-engine) has NO residency logic of its own: a cron
// schedule fires and calls back into `onTriggerScheduledTask` (apps/webapp/app/v3/scheduleEngine.server.ts),
// which mints the run via the ORDINARY TriggerTaskService -> RunEngine.trigger -> RoutingRunStore.createRun
// path — the same mint path already exercised by internal-packages/run-engine/src/engine/tests/triggerCreateRouting.test.ts
// and the `case 1` / `case 1b` findRuns-by-id-set tests in runOpsStore.mixedResidency.test.ts. There is no
// schedule-specific residency branch to test at the mint step; schedules simply inherit whatever the trigger
// path already does. Case A below adds exactly ONE small confirming test (using the previously-untested
// `scheduleId`/`scheduleInstanceId` scalar fields specifically) rather than re-deriving that generic coverage.
//
// The one piece of schedule-adjacent logic that genuinely spans the seam and had NO hetero coverage is
// `rescheduleRun` (RoutingRunStore.rescheduleRun, runOpsStore.ts:617) — the write delegate behind the
// delayed-run "reschedule" API (apps/webapp/app/v3/services/rescheduleTaskRun.server.ts) and
// `DelayedRunSystem.rescheduleDelayedRun`. It is a pure `#routeForWrite(runId)` mechanical delegate with
// no dedicated mixed-residency test anywhere in the existing matrix (runOpsStore.mixedResidency.test.ts
// covers batch/waitpoint/find methods but not rescheduleRun). Case B below closes that gap.
//
// Real two-physical-DB fixture, NO MOCKS: heteroRunOpsPostgresTest (prisma14 = full control-plane/LEGACY
// schema, prisma17 = RunOpsPrismaClient dedicated NEW-subset schema).

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput, RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies by internal-id LENGTH after stripping a leading `<prefix>_`
// (runOpsResidency.ts): 25 chars → cuid → LEGACY, a v1 body (version "1" at index 25 of a 26-char
// body) → run-ops id → NEW. Mirrors the helpers in runOpsStore.mixedResidency.test.ts so ids classify
// the same way here (the documented ID pitfall: a naive generator misclassifies NEW ids as LEGACY).
function cuidLegacy(seed: string): string {
  return (seed + "c".repeat(25)).slice(0, 25); // 25 chars → LEGACY (#legacy / prisma14)
}
function runOpsNew(seed: string): string {
  return (seed.replace(/[^0-9a-v]/g, "0") + "k".repeat(24)).slice(0, 24) + "01"; // 26 chars, version "1" at index 25 → NEW (#new / prisma17)
}

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

async function seedSharedEnv(prisma14: PrismaClient, suffix: string) {
  const legacy = await seedEnvironment(prisma14, "legacy", suffix);
  return {
    organizationId: legacy.organization.id,
    projectId: legacy.project.id,
    runtimeEnvironmentId: legacy.environment.id,
    environmentId: legacy.environment.id,
  };
}

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  status?: "PENDING" | "DELAYED";
  scheduleId?: string;
  scheduleInstanceId?: string;
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
      taskIdentifier: "my-scheduled-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      traceContext: { trace: "ctx" },
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      runTags: [],
      queue: "task/my-scheduled-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      ...(params.scheduleId && { scheduleId: params.scheduleId }),
      ...(params.scheduleInstanceId && { scheduleInstanceId: params.scheduleInstanceId }),
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
// prisma14.
function makeSplitRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyStore = makeLegacyStore(prisma14);
  const newStore = makeDedicatedStore(prisma17);
  return {
    router: new RoutingRunStore({ new: newStore, legacy: legacyStore }),
    legacyStore,
    newStore,
  };
}

describe("Schedules over the cutover seam", () => {
  // ── Case A: a schedule-minted run (scheduleId/scheduleInstanceId set) lands on the correct
  // physical store under mixed residency, and is found by plain id lookup (the ONLY lookup that
  // exists — there is no scheduleInstanceId-keyed TaskRun query anywhere in the codebase; the field
  // is write-only metadata stamped at creation). This confirms schedules have no distinct mint-routing
  // seam beyond the already-covered generic createRun routing. ──
  heteroRunOpsPostgresTest(
    "case A: a schedule-minted run routes to the owning store and resolves by id, for both residencies",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "schedA");

      const legacyRun = cuidLegacy("schAl"); // pre-cutover mint shape → #legacy
      const newRun = runOpsNew("schAn"); // run-ops mint shape → #new

      await router.createRun(
        buildCreateRunInput({
          runId: legacyRun,
          friendlyId: "run_schedA_legacy",
          scheduleId: "sched_A",
          scheduleInstanceId: "schedinst_A_legacy",
          ...env,
        })
      );
      await router.createRun(
        buildCreateRunInput({
          runId: newRun,
          friendlyId: "run_schedA_new",
          scheduleId: "sched_A",
          scheduleInstanceId: "schedinst_A_new",
          ...env,
        })
      );

      // Physical residency: each landed on its OWN DB only, with the scheduleInstanceId intact.
      const onLegacy = await prisma14.taskRun.findUnique({ where: { id: legacyRun } });
      expect(onLegacy?.scheduleInstanceId).toBe("schedinst_A_legacy");
      expect(await prisma17.taskRun.findUnique({ where: { id: legacyRun } })).toBeNull();

      const onNew = await prisma17.taskRun.findUnique({ where: { id: newRun } });
      expect(onNew?.scheduleInstanceId).toBe("schedinst_A_new");
      expect(await prisma14.taskRun.findUnique({ where: { id: newRun } })).toBeNull();

      // The only lookup a schedule-minted run ever needs (by id) resolves through the router on
      // BOTH residencies.
      const foundLegacy = (await router.findRun(
        { id: legacyRun },
        { select: { id: true, scheduleInstanceId: true } }
      )) as Record<string, any> | null;
      expect(foundLegacy?.id).toBe(legacyRun);
      expect(foundLegacy?.scheduleInstanceId).toBe("schedinst_A_legacy");

      const foundNew = (await router.findRun(
        { id: newRun },
        { select: { id: true, scheduleInstanceId: true } }
      )) as Record<string, any> | null;
      expect(foundNew?.id).toBe(newRun);
      expect(foundNew?.scheduleInstanceId).toBe("schedinst_A_new");
    }
  );

  // ── Case B: rescheduleRun (the write delegate behind the delayed-run "reschedule" API and
  // DelayedRunSystem.rescheduleDelayedRun) routes to the OWNING store for a mixed-residency
  // population, and does NOT touch the other physical DB. No existing hetero test covers this
  // write path. ──
  heteroRunOpsPostgresTest(
    "case B: rescheduleRun routes the write to the owning store only, for a mixed-residency population",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "schedB");

      const legacyRun = cuidLegacy("schBl");
      const newRun = runOpsNew("schBn");

      await router.createRun(
        buildCreateRunInput({
          runId: legacyRun,
          friendlyId: "run_schedB_legacy",
          status: "DELAYED",
          ...env,
        })
      );
      await router.createRun(
        buildCreateRunInput({
          runId: newRun,
          friendlyId: "run_schedB_new",
          status: "DELAYED",
          ...env,
        })
      );

      const legacyDelayUntil = new Date("2027-05-01T00:00:00.000Z");
      const newDelayUntil = new Date("2027-06-01T00:00:00.000Z");

      const updatedLegacy = await router.rescheduleRun(legacyRun, {
        delayUntil: legacyDelayUntil,
        snapshot: {
          environmentId: env.environmentId,
          environmentType: "DEVELOPMENT",
          projectId: env.projectId,
          organizationId: env.organizationId,
        },
      });
      const updatedNew = await router.rescheduleRun(newRun, {
        delayUntil: newDelayUntil,
        snapshot: {
          environmentId: env.environmentId,
          environmentType: "DEVELOPMENT",
          projectId: env.projectId,
          organizationId: env.organizationId,
        },
      });

      expect(updatedLegacy.id).toBe(legacyRun);
      expect(updatedLegacy.delayUntil).toEqual(legacyDelayUntil);
      expect(updatedNew.id).toBe(newRun);
      expect(updatedNew.delayUntil).toEqual(newDelayUntil);

      // The write landed on the OWNING physical DB only.
      const legacyRow = await prisma14.taskRun.findUnique({ where: { id: legacyRun } });
      expect(legacyRow?.delayUntil).toEqual(legacyDelayUntil);
      const legacySnapshots = await prisma14.taskRunExecutionSnapshot.findMany({
        where: { runId: legacyRun, executionStatus: "DELAYED" },
      });
      expect(legacySnapshots).toHaveLength(1);

      const newRow = await prisma17.taskRun.findUnique({ where: { id: newRun } });
      expect(newRow?.delayUntil).toEqual(newDelayUntil);
      const newSnapshots = await prisma17.taskRunExecutionSnapshot.findMany({
        where: { runId: newRun, executionStatus: "DELAYED" },
      });
      expect(newSnapshots).toHaveLength(1);

      // Cross-DB isolation: the OTHER physical DB's row for each run is untouched by the other
      // reschedule call — neither run exists on the non-owning DB at all, so there is nothing there
      // to have been (mis)updated.
      expect(await prisma17.taskRun.findUnique({ where: { id: legacyRun } })).toBeNull();
      expect(await prisma14.taskRun.findUnique({ where: { id: newRun } })).toBeNull();
    }
  );
});
