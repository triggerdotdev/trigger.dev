// Lagging-replica coverage for the model-runtime-env read view on the run-ops split.
//
// findEnvironmentFromRun's findRun reads the run-ops scalars {runTags, batchId, runtimeEnvironmentId}
// off a run and resolves the authenticated env from them. The webapp calls it with NO tx from the
// `runMetadataUpdated` engine handler, so the client arg is the branded `$replica` handle and the
// read is REPLICA-routed.
//
// Routing (against runOpsStore.ts): findRun(where {id}, select, BRANDED $replica) → id classifiable →
// owning store first; a branded read-replica client is not a write signal, so the read stays on the
// owning store's REPLICA, then fans out to the OTHER store's replica on a miss. A cuid run owns
// LEGACY, so its frozen legacy replica is the one hit.
//
// Why read-your-writes matters here: the handler treats a null result as "Failed to find environment"
// and RETURNS, dropping BOTH the final-metadata write (updateMetadataService.call, which itself
// reads/writes the PRIMARY within the post-completion grace window) AND the realtime run-changed
// publish. The event is one-shot at attempt completion — no retry loop, no primary fallback. For a
// fast run whose lifetime is shorter than replica lag the owning replica lacks the row, so a
// replica-routed read misses a live, primary-resident run. Routing this read to the owning PRIMARY
// keeps the precheck at least as consistent as the mutation it gates (which already reads the primary).
//
// This proves the store fact at the seam: freeze the OWNING replica with the shared laggingReplica
// primitive, invoke findRun EXACTLY as the caller does (same where + select + branded-replica
// client), assert the null under lag AND that the identical row IS on the owning primary (so the miss
// is provably lag-induced and the primary re-read recovers it). Real split topology via
// heteroRunOpsPostgresTest — NEVER mocked.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import { markReadReplicaClient } from "./readReplicaClient.js";
import type { CreateRunInput } from "./types.js";

// ownerEngine (classifyResidency) routes a run-ops v1 body → NEW, everything else → LEGACY. A cuid
// run owns LEGACY (the control-plane DB), the residency of a run whose completion emits
// runMetadataUpdated, so the owning store is LEGACY and its frozen replica is the one this read hits.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / prisma14, full schema)

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

// The webapp always passes its $replica handle, which is markReadReplicaClient()'d. A branded client
// tells RoutingRunStore "do not escalate to primary" — the read stays on the owning store's replica.
// Its identity is irrelevant; the router discards it and reads the owning store's readOnlyPrisma.
const BRANDED_REPLICA = markReadReplicaClient({}) as never;

describe("run-ops split — model-runtime-env (findEnvironmentFromRun) read view vs. a lagging replica", () => {
  // The findEnvironmentFromRun read (branded $replica).
  heteroRunOpsPostgresTest(
    "findEnvironmentFromRun findRun(branded $replica) is NULL under owning-replica lag — runMetadataUpdated handler drops the final-metadata write + realtime publish for a live run; primary re-read recovers it",
    async ({ prisma14, prisma17 }) => {
      // Build the router the way the webapp holds it: a LEGACY store on the control-plane DB whose
      // replica LAGS, plus a fresh NEW store. The run is a cuid → LEGACY-resident.
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

      const seed = await seedEnvironment(prisma14, "modelenv");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      const friendlyId = "run_modelenv";
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // The EXACT env-resolve read: where {id}, select {runTags, batchId, runtimeEnvironmentId}, $replica.
      const staleRead = (await router.findRun(
        { id: runId },
        { select: { runTags: true, batchId: true, runtimeEnvironmentId: true } },
        BRANDED_REPLICA
      )) as { runTags: string[]; batchId: string | null; runtimeEnvironmentId: string } | null;

      // Store fact: the read is REPLICA-routed and the owning replica lags → null. The fan-out probes
      // the LEGACY replica (owner) first, then the NEW replica; the frozen legacy replica records a hit.
      expect(staleRead).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // Caller decision, exercised: findEnvironmentFromRun returns null on the miss, so the
      // runMetadataUpdated handler logs "Failed to find environment" and RETURNS — never calling
      // updateMetadataService.call (the final-metadata write) or publishChangeRecord (realtime). For
      // this LIVE run that is a dropped mutation, not a tolerated stale display value.
      const environmentFromRun = staleRead
        ? { runtimeEnvironmentId: staleRead.runtimeEnvironmentId }
        : null;
      expect(environmentFromRun).toBeNull(); // → handler aborts: metadata write + realtime publish dropped

      // Read-your-writes: re-reading the owning PRIMARY (pass the WRITER `prisma14` → the router
      // escalates to findRunOnPrimary) returns the live run with the exact scalars the env-resolve
      // needs. Routing findEnvironmentFromRun to the owning primary keeps this consistent with
      // updateMetadataService.call's own primary read.
      const primaryRead = (await router.findRun(
        { id: runId },
        { select: { runTags: true, batchId: true, runtimeEnvironmentId: true } },
        prisma14 as never
      )) as { runTags: string[]; batchId: string | null; runtimeEnvironmentId: string } | null;
      expect(primaryRead).not.toBeNull();
      expect(primaryRead!.runtimeEnvironmentId).toBe(seed.environment.id);
      expect(primaryRead!.runTags).toEqual(["alpha", "beta"]);
    }
  );
});
