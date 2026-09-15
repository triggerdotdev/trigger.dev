// Lagging-replica coverage for the CANCEL route's run lookups on the run-ops split.
//
// The cancel route issues two friendlyId-keyed run reads through the shared runStore — the
// org-resolution read (resolveRunOrganizationId) and the cancel-decision read (action body) — both
// client-less, so both route to the OWNING store's REPLICA. Property: reading with the owning WRITER
// (the primary fallback / findRunOnPrimary) resolves a just-written run the replica has not yet
// received, so the cancel decision does not act on a stale miss.
//
// This is the same read-your-writes class as the other lag guards: a replica read whose result drives
// a decision (cancel vs. not-found). These tests freeze the owning replica with the shared
// laggingReplica primitive and prove, at the store seam, exactly what the route sees — the client-less
// read is null under lag, the writer read finds the row. Real split topology via
// heteroRunOpsPostgresTest — NEVER mocked.

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
      taskIdentifier: params.taskIdentifier,
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

// Exactly the projection the cancel action reads (subset that exists on both variants).
const CANCEL_SELECT = {
  id: true,
  engine: true,
  status: true,
  friendlyId: true,
  projectId: true,
} as const;

describe("run-ops split — cancel-route run lookup vs. a lagging replica (read-your-writes)", () => {
  // (a) LEGACY-resident (cuid) run committed to the control-plane WRITER; the control-plane replica
  // lags. Mirrors the moment a buffered run has just drained to the primary but not yet replicated.
  heteroRunOpsPostgresTest(
    "LEGACY cuid: no-client findRun is STALE under lag; the primary re-read finds it",
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

      const seed = await seedEnvironment(prisma14, "legacy", "cancel_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      const friendlyId = "run_cancel_leg";
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          taskIdentifier: "my-task",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // The exact cancel-route read — friendlyId, select, NO client → replica.
      const staleRead = await router.findRun({ friendlyId }, { select: CANCEL_SELECT });

      // The run exists on the primary but the replica lags, so the client-less read returns null.
      // Re-reading the primary on this miss (as the org-resolution read does) resolves the live run,
      // so the cancel does not act on a stale miss.
      expect(staleRead).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // Re-read via the control-plane WRITER (the same primary fallback the org-resolution read uses,
      // routing to the owning store's primary) — this finds the run.
      const primaryRead = await router.findRun(
        { friendlyId },
        { select: CANCEL_SELECT },
        prisma14 as never
      );
      expect(primaryRead).not.toBeNull();
      expect(primaryRead!.friendlyId).toBe(friendlyId);
      expect(primaryRead!.id).toBe(runId);
    }
  );

  // (b) NEW-resident (ksuid) run on the dedicated subset schema; the NEW replica lags.
  heteroRunOpsPostgresTest(
    "NEW ksuid: no-client findRun is STALE under NEW replica lag; the primary re-read finds it",
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

      const seed = await seedEnvironment(prisma17, "dedicated", "cancel_new");
      const runId = NEW_RUN_ID; // v1 body → NEW
      // friendlyId classifies identically to the id, so a NEW run's friendlyId must be run-ops-shaped
      // for the by-friendlyId read to route to NEW (single-store; no cross-store fan-out).
      const friendlyId = `run_${generateRunOpsId()}`;
      await newStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          taskIdentifier: "my-task",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      const staleRead = await router.findRun({ friendlyId }, { select: CANCEL_SELECT });
      expect(staleRead).toBeNull();
      expect(newReplica.wasHit()).toBe(true);

      const primaryRead = await router.findRun(
        { friendlyId },
        { select: CANCEL_SELECT },
        prisma17 as never
      );
      expect(primaryRead).not.toBeNull();
      expect(primaryRead!.friendlyId).toBe(friendlyId);
      expect(primaryRead!.id).toBe(runId);
    }
  );
});
