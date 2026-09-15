// Coverage for two friendlyId-keyed run reads that pass the webapp's BRANDED `$replica` into
// `runStore.findRun`. A branded replica makes `readYourWrites` return false, so the routing store keeps
// the read on the OWNING store's REPLICA (no primary escalation). Under lag both miss a row present on
// the owning primary. Real split topology via heteroRunOpsPostgresTest; the branded arg is
// `markReadReplicaClient({})`, whose object is never forwarded across DBs — only its BRAND is read.
//
// Reads covered (one case each):
//   1. end-and-continue callingRun lookup
//        runStore.findRun({ friendlyId: callingRunId, runtimeEnvironmentId }, { select:{id} }, $replica)
//        → owning REPLICA. On null → 404 "callingRunId not found in this environment".
//        SAFE: `callingRunId` is `ctx.run.id` of the run CURRENTLY EXECUTING and issuing this API call.
//        An executing run was materialised to the primary and dequeued long before it runs user code, so
//        its row replicated well before this request — bounded lag cannot miss it. (Contrast the same
//        route's read of the just-swapped run, which correctly passes the WRITER `prisma`.)
//   2. metadata GET loader
//        runStore.findRun({ friendlyId, runtimeEnvironmentId }, { select:{metadata,metadataType} }, $replica)
//        → owning REPLICA. On null the loader's only miss fallback is the mollifier buffer
//        (buffer.getEntry — no primary re-read). Once a run has drained from the buffer to the primary
//        but the replica has not caught up, it exists on NEITHER the replica NOR the buffer. The primary
//        re-read (pass the WRITER `prisma`, i.e. findRunOnPrimary) recovers the live run before the 404.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import { markReadReplicaClient } from "./readReplicaClient.js";
import type { CreateRunInput } from "./types.js";

// A cuid (25 chars after the `run_` prefix) classifies LEGACY, so create + friendlyId-keyed read
// both route to the legacy (control-plane) store first — the store that owns these session/run rows.
const CUID_25 = "c".repeat(25);

async function seedEnvironmentLegacy(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
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
  metadata?: string;
  metadataType?: string;
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
      metadata: params.metadata,
      metadataType: params.metadataType,
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_1",
      spanId: "span_1",
      runTags: ["alpha"],
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

// Build the router the way the webapp holds it, with a lagging legacy (control-plane) replica.
function buildRouterWithLaggingLegacyReplica(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
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
  return { router, legacyStore, legacyReplica };
}

describe("session and metadata route findRun read-views under replica lag", () => {
  // end-and-continue callingRun lookup.
  heteroRunOpsPostgresTest(
    "end-and-continue callingRun read is stale-null under replica lag",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouterWithLaggingLegacyReplica(
        prisma14,
        prisma17
      );

      const seed = await seedEnvironmentLegacy(prisma14, "eac_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      const friendlyId = "run_eac_calling";
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // The branded $replica client arg (its object is never forwarded; only its brand is read).
      const brandedReplica = markReadReplicaClient({} as object);

      // The EXACT :78 read: friendlyId + runtimeEnvironmentId, select {id}, branded $replica.
      const staleRead = (await router.findRun(
        { friendlyId, runtimeEnvironmentId: seed.environment.id },
        { select: { id: true } },
        brandedReplica
      )) as { id: string } | null;

      // Store fact: branded-replica read is REPLICA-routed, so under lag it misses → null.
      // A null return leads to a 404 "callingRunId not found in this environment".
      expect(staleRead).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // TOLERANCE premise proof: the row DOES exist on the owning primary. In production
      // `callingRunId` = ctx.run.id of the CURRENTLY-EXECUTING caller, materialised + dequeued long
      // before it runs user code, so it replicated well before the request — bounded lag can't miss
      // it. The WRITER read (unbranded → readYourWrites → owning primary) recovers it here.
      const primaryRead = (await router.findRun(
        { friendlyId, runtimeEnvironmentId: seed.environment.id },
        { select: { id: true } },
        prisma14 as never
      )) as { id: string } | null;
      expect(primaryRead).not.toBeNull();
      expect(primaryRead!.id).toBe(runId);
    }
  );

  // metadata GET loader.
  heteroRunOpsPostgresTest(
    "metadata loader read is stale-null under replica lag",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouterWithLaggingLegacyReplica(
        prisma14,
        prisma17
      );

      const seed = await seedEnvironmentLegacy(prisma14, "meta_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      const friendlyId = "run_meta_view";
      const metadata = '{"phase":"one"}';
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          metadata,
          metadataType: "application/json",
        })
      );

      const brandedReplica = markReadReplicaClient({} as object);

      // The EXACT :43 read: friendlyId + runtimeEnvironmentId, select {metadata, metadataType}, branded $replica.
      const staleRead = (await router.findRun(
        { friendlyId, runtimeEnvironmentId: seed.environment.id },
        { select: { metadata: true, metadataType: true } },
        brandedReplica
      )) as { metadata: string | null; metadataType: string } | null;

      // Store fact: branded-replica read is REPLICA-routed → stale/null under lag. The loader then
      // consults ONLY the mollifier buffer (buffer.getEntry, no primary read); once the run has drained
      // from the buffer to the primary, the buffer miss + this replica miss together yield a 404
      // "Run not found" for a run that exists on the owning primary.
      expect(staleRead).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // The property: re-reading the owning PRIMARY (pass the WRITER `prisma` → findRunOnPrimary) returns
      // the live run with its metadata, so the primary re-read on the double-miss resolves it.
      const primaryRead = (await router.findRun(
        { friendlyId, runtimeEnvironmentId: seed.environment.id },
        { select: { metadata: true, metadataType: true } },
        prisma14 as never
      )) as { metadata: string | null; metadataType: string } | null;
      expect(primaryRead).not.toBeNull();
      expect(primaryRead!.metadata).toBe(metadata);
      expect(primaryRead!.metadataType).toBe("application/json");
    }
  );
});
