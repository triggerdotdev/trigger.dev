// Read-after-write coverage for the USAGE/COST read-modify-write in the attempt-completion path
// (attemptSucceeded, and the same shape in cancelRun / #permanentlyFailRun). The completion path reads
// the run's CUMULATIVE usageDurationMs/costInCents, recomputes, and writes back. Across a run's retries
// usage accumulates on the OWNING store's PRIMARY (each completion is a read-modify-write); if the read
// were served by a lagging replica pinned at a pre-delta snapshot, the recomputed total would be built
// on the STALE cumulative and the prior delta LOST -> usage/cost UNDERCOUNT (a classic lost update).
// Reading via findRunOnPrimary (the owning store's PRIMARY) keeps the total correct.
//
// Deterministic via heteroRunOpsPostgresTest (real split topology, never mocked) + the shared
// laggingReplica primitive (frozen mode: the owning store's replica is pinned at the pre-delta snapshot
// while the primary advances). The property: the primary read sees the fresher cumulative and the write
// preserves it; a client-less (replica) read would clobber it downward.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CompletionSnapshotInput, CreateRunInput, RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine (classifyResidency) routes a cuid → LEGACY (#legacy / prisma14, full schema).
const CUID_25 = "d".repeat(25);

async function seedEnvironment(
  prisma: AnyClient,
  schemaVariant: RunStoreSchemaVariant,
  slugSuffix: string
) {
  if (schemaVariant === "dedicated") {
    return {
      organization: { id: `org_${slugSuffix}` },
      project: { id: `proj_${slugSuffix}` },
      environment: { id: `env_${slugSuffix}` },
    };
  }
  const organization = await (prisma as PrismaClient).organization.create({
    data: { title: `Org ${slugSuffix}`, slug: `org-${slugSuffix}` },
  });
  const project = await (prisma as PrismaClient).project.create({
    data: {
      name: `Project ${slugSuffix}`,
      slug: `project-${slugSuffix}`,
      externalRef: `proj_${slugSuffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await (prisma as PrismaClient).runtimeEnvironment.create({
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
  taskIdentifier: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "EXECUTING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: params.taskIdentifier,
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
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "EXECUTING",
      description: "Run is executing",
      runStatus: "EXECUTING",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

// Line-for-line mirror of runAttemptSystem.attemptSucceeded's usage read-modify-write (dev-mode:
// cost is a pure passthrough of the read `currentCostInCents`, per #calculateUpdatedUsage's
// `environmentType !== "DEVELOPMENT"` guard). The cumulative read goes to the owning primary via
// findRunOnPrimary, exactly as the engine issues it.
async function attemptSucceededRecomputeUsage(
  router: RoutingRunStore,
  params: {
    runId: string;
    attemptDurationMs: number;
    snapshot: CompletionSnapshotInput;
  }
): Promise<void> {
  // Read current usage totals via findRunOnPrimary (owning store's PRIMARY), as
  // attemptSucceeded/cancelRun/#permanentlyFailRun do.
  const currentRun = (await router.findRunOnPrimary(
    { id: params.runId },
    {
      select: {
        usageDurationMs: true,
        costInCents: true,
        machinePreset: true,
      },
    }
  )) as { usageDurationMs: number; costInCents: number; machinePreset: string | null } | null;

  if (!currentRun) {
    throw new Error("Run not found");
  }

  // #calculateUpdatedUsage, DEVELOPMENT branch: usage accumulates, cost passes through unchanged.
  const usageDurationMs = currentRun.usageDurationMs + params.attemptDurationMs;
  const costInCents = currentRun.costInCents;

  await router.completeAttemptSuccess(
    params.runId,
    {
      completedAt: new Date(),
      output: '{"done":true}',
      outputType: "application/json",
      usageDurationMs,
      costInCents,
      snapshot: params.snapshot,
    },
    { select: { id: true, usageDurationMs: true, costInCents: true } }
  );
}

describe("run-ops split — attempt-completion usage/cost read-modify-write must read the OWNING store's WRITER, not its lagging replica", () => {
  // A LEGACY-resident (cuid) run whose earlier attempts already accumulated usage/cost on the
  // control-plane PRIMARY, while the control-plane REPLICA still lags at the pre-delta snapshot.
  // The final attemptSucceeded reads the cumulative usage on the owning primary, recomputes, and
  // writes back — so the fresher primary total is preserved (no lost update); a replica-routed read
  // would clobber it downward.
  heteroRunOpsPostgresTest(
    "LEGACY cuid: attemptSucceeded accumulates usage on the primary total, not the lagging replica",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironment(prisma14, "legacy", "usage_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY

      // Build the store on the PRIMARY first so createRun + the "prior attempt" write both land there.
      const primaryLegacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      await primaryLegacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_usage_leg",
          taskIdentifier: "my-task",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // The pre-delta snapshot the replica is still pinned at: usage/cost as freshly created (both 0).
      const staleRun = await prisma14.taskRun.findFirstOrThrow({ where: { id: runId } });
      const PRIOR_USAGE = staleRun.usageDurationMs; // 0 at create
      const PRIOR_COST = staleRun.costInCents; // 0 at create

      // A prior attempt's read-modify-write already committed a cumulative delta to the PRIMARY.
      const PRIOR_ATTEMPT_USAGE_MS = 1000;
      const PRIOR_ATTEMPT_COST = 250;
      await prisma14.taskRun.update({
        where: { id: runId },
        data: {
          usageDurationMs: PRIOR_USAGE + PRIOR_ATTEMPT_USAGE_MS,
          costInCents: PRIOR_COST + PRIOR_ATTEMPT_COST,
        },
      });

      // The control-plane replica lags: frozen at the pre-delta snapshot (usage/cost = 0).
      const legacyReplica = laggingReplica(prisma14, [
        {
          model: "taskRun",
          mode: "frozen",
          rows: [staleRun as unknown as Record<string, unknown>],
        },
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

      // The final successful attempt adds its own delta on top of the accumulated total.
      const FINAL_ATTEMPT_USAGE_MS = 500;
      await attemptSucceededRecomputeUsage(router, {
        runId,
        attemptDurationMs: FINAL_ATTEMPT_USAGE_MS,
        snapshot: {
          executionStatus: "FINISHED",
          description: "Task completed successfully",
          runStatus: "COMPLETED_SUCCESSFULLY",
          attemptNumber: 2,
          environmentId: seed.environment.id,
          environmentType: "DEVELOPMENT",
          projectId: seed.project.id,
          organizationId: seed.organization.id,
        },
      });

      // The cumulative-usage read hits the owning PRIMARY, so the lagging replica is never consulted
      // (a client-less read would hit it and undercount).
      expect(legacyReplica.wasHit("taskRun")).toBe(false);

      // Ground truth lives on the PRIMARY. Correct cumulative total = prior accumulated + this attempt.
      const finalRun = await prisma14.taskRun.findFirstOrThrow({ where: { id: runId } });

      // The primary read sees the accumulated 1000ms/250c, so the RMW writes 1000 + 500 = 1500 (no
      // undercount). A client-less (replica) read would recompute 0 + 500 = 500.
      expect(finalRun.usageDurationMs).toBe(
        PRIOR_USAGE + PRIOR_ATTEMPT_USAGE_MS + FINAL_ATTEMPT_USAGE_MS
      );
      expect(finalRun.costInCents).toBe(PRIOR_COST + PRIOR_ATTEMPT_COST);
    }
  );
});
