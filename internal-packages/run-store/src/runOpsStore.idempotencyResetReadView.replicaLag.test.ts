// Lagging-replica coverage for the IDEMPOTENCY-KEY RESET route's source-run lookup on the run-ops split.
// The reset action reads the run by friendlyId with NO client (→ OWNING store's REPLICA, fan-out to the
// other store's replica on a miss) and that result gates the whole reset — a DECISION-DRIVING read.
// Under lag the read returns null for a run that exists on the primary. These tests build the store as
// the route holds it, seed the run on the OWNING primary, freeze the OWNING replica via laggingReplica,
// and invoke the read EXACTLY as the route does, then show the owning-WRITER read escalates to the
// primary and resolves the run + its idempotencyKey. Real split topology via heteroRunOpsPostgresTest — NEVER mocked.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput, RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine (classifyResidency) routes a run-ops v1 body → NEW, everything else → LEGACY.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / prisma14, full schema)
const NEW_RUN_ID = `run_${generateRunOpsId()}`; // valid v1 body → NEW (#new / prisma17, dedicated)

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
  idempotencyKey: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: params.taskIdentifier,
      // The reset route only makes sense for a run triggered WITH an idempotency key.
      idempotencyKey: params.idempotencyKey,
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_1",
      spanId: "span_1",
      runTags: ["alpha", "beta"],
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

// Exactly the projection the reset action reads.
const RESET_SELECT = {
  id: true,
  idempotencyKey: true,
  taskIdentifier: true,
  projectId: true,
  runtimeEnvironmentId: true,
} as const;

describe("run-ops split — idempotency-key reset source-run lookup vs. a lagging replica (read-your-writes)", () => {
  // LEGACY cuid resident. The run is committed to the control-plane WRITER; the control-plane replica
  // lags (the buffer-drained-but-not-yet-replicated window). The route's no-client findRun hits that
  // replica and returns null for a run that exists on the primary; the owning-writer re-read resolves it.
  heteroRunOpsPostgresTest(
    "LEGACY cuid: no-client findRun is stale under lag; owning-primary re-read finds it",
    async ({ prisma14, prisma17 }) => {
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

      const seed = await seedEnvironment(prisma14, "legacy", "idem_reset_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      const friendlyId = "run_idem_reset_leg";
      const idempotencyKey = "user-supplied-key-leg";
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          taskIdentifier: "my-task",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          idempotencyKey,
        })
      );

      // The exact reset-route read — friendlyId + RESET_SELECT, NO client → replica.
      const staleRead = await router.findRun({ friendlyId }, { select: RESET_SELECT });

      // The run exists on the primary but the replica lags, so the no-client read returns null. In the
      // route this is the "Run not found" short-circuit, before ResetIdempotencyKeyService runs. The
      // owning-writer re-read below is the property that resolves the run under lag.
      expect(staleRead).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // Pass the control-plane WRITER to findRun so it escalates to findRunOnPrimary. This resolves the
      // run + its idempotencyKey under lag.
      const primaryRead = await router.findRun(
        { friendlyId },
        { select: RESET_SELECT },
        prisma14 as never
      );
      expect(primaryRead).not.toBeNull();
      expect(primaryRead!.id).toBe(runId);
      // The idempotencyKey the reset service needs is only visible via the primary.
      expect(primaryRead!.idempotencyKey).toBe(idempotencyKey);
    }
  );

  // Same property on a NEW-resident (ksuid) run; the NEW replica lags. Not legacy-specific: whichever
  // store owns the run, the no-client read hits its lagging replica and the owning-writer re-read resolves it.
  heteroRunOpsPostgresTest(
    "NEW ksuid: no-client findRun is stale under NEW replica lag; owning-primary re-read finds it",
    async ({ prisma14, prisma17 }) => {
      const newReplica = laggingReplica(prisma17, [{ model: "taskRun", mode: "missing" }]);
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: newReplica.client as never,
        schemaVariant: "dedicated",
      });
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = await seedEnvironment(prisma17, "dedicated", "idem_reset_new");
      const runId = NEW_RUN_ID; // v1 body → NEW
      // A NEW run's friendlyId must be run-ops-shaped so the by-friendlyId read routes to NEW
      // (single-store; friendlyId classifies identically to the id).
      const friendlyId = `run_${generateRunOpsId()}`;
      const idempotencyKey = "user-supplied-key-new";
      await newStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          taskIdentifier: "my-task",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          idempotencyKey,
        })
      );

      const staleRead = await router.findRun({ friendlyId }, { select: RESET_SELECT });
      expect(staleRead).toBeNull();
      expect(newReplica.wasHit()).toBe(true);

      const primaryRead = await router.findRun(
        { friendlyId },
        { select: RESET_SELECT },
        prisma17 as never
      );
      expect(primaryRead).not.toBeNull();
      expect(primaryRead!.id).toBe(runId);
      expect(primaryRead!.idempotencyKey).toBe(idempotencyKey);
    }
  );
});
