// Verifies the waitpoint idempotency dedup reads the OWNING store's WRITER, not its lagging replica.
// createDateTimeWaitpoint/createManualWaitpoint dedup on a retry via findWaitpoint({environmentId,
// idempotencyKey}, undefined, {coLocateWithRunId}); colocated with the owning run it must resolve
// attempt-1's just-written waitpoint on the primary so isCached fires and the run does not re-arm.
// Deterministic via heteroRunOpsPostgresTest (real split topology, never mocked) + a lagging-replica
// proxy whose `waitpoint` reads return empty and record that they ran.

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

// On the dedicated subset there are no Organization/Project/RuntimeEnvironment models (the run-ops
// rows carry FK-free scalar ids), so we mint synthetic owning ids. On legacy we seed the real rows
// the kept FKs require.
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

// Seed attempt-1's already-completed DATETIME waitpoint (user-provided idempotencyKey) on the WRITER,
// exactly as `createDateTimeWaitpoint`'s upsert would have written it on the first attempt.
async function seedCompletedDateTimeWaitpoint(
  store: PostgresRunStore,
  params: {
    id: string;
    friendlyId: string;
    projectId: string;
    environmentId: string;
    idempotencyKey: string;
  }
) {
  const completedAfter = new Date(Date.now() - 60_000);
  await store.upsertWaitpoint({
    where: {
      environmentId_idempotencyKey: {
        environmentId: params.environmentId,
        idempotencyKey: params.idempotencyKey,
      },
    },
    create: {
      id: params.id,
      friendlyId: params.friendlyId,
      type: "DATETIME",
      status: "COMPLETED",
      idempotencyKey: params.idempotencyKey,
      userProvidedIdempotencyKey: true,
      idempotencyKeyExpiresAt: new Date(Date.now() + 60 * 60_000),
      projectId: params.projectId,
      environmentId: params.environmentId,
      completedAfter,
      completedAt: completedAfter,
    },
    update: {},
  });
}

describe("run-ops split — waitpoint idempotency dedup reads the OWNING store's WRITER, not its lagging replica", () => {
  // The dedup probe issued by createDateTimeWaitpoint/createManualWaitpoint on a RETRY:
  //   findWaitpoint({ where: { environmentId, idempotencyKey } }, undefined, { coLocateWithRunId })
  // must resolve attempt-1's just-written waitpoint via the OWNING store's primary, so isCached fires
  // and the run does NOT re-arm/re-block. Proven for BOTH residencies + a routing guard.

  // (a) LEGACY-resident (cuid) run: attempt-1's waitpoint was committed to the control-plane writer;
  // the control-plane replica lags. The colocated dedup must find it on the owning (legacy) writer.
  heteroRunOpsPostgresTest(
    "LEGACY cuid: colocated dedup finds attempt-1's waitpoint despite replica lag",
    async ({ prisma14, prisma17 }) => {
      const legacyReplica = laggingReplica(prisma14, [{ model: "waitpoint", mode: "missing" }]);
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

      const seed = await seedEnvironment(prisma14, "legacy", "wp_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_wp_leg",
          taskIdentifier: "my-task",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );
      const idempotencyKey = "wuik-legacy";
      await seedCompletedDateTimeWaitpoint(legacyStore, {
        id: `waitpoint_${CUID_25}`,
        friendlyId: "waitpoint_wp_leg",
        projectId: seed.project.id,
        environmentId: seed.environment.id,
        idempotencyKey,
      });

      // The exact dedup probe: no client, colocated with the owning run.
      const found = await router.findWaitpoint(
        { where: { environmentId: seed.environment.id, idempotencyKey } },
        undefined,
        { coLocateWithRunId: runId }
      );

      // Resolved on the owning store's writer; the replica is never consulted.
      expect(found).not.toBeNull();
      expect(found!.idempotencyKey).toBe(idempotencyKey);
      expect(found!.status).toBe("COMPLETED");
      expect(legacyReplica.wasHit()).toBe(false);
    }
  );

  // (b) NEW-resident (ksuid) run on the dedicated subset schema: the NEW replica lags. The colocated
  // dedup must resolve on the NEW writer.
  heteroRunOpsPostgresTest(
    "NEW ksuid: colocated dedup finds attempt-1's waitpoint despite NEW replica lag",
    async ({ prisma14, prisma17 }) => {
      const newReplica = laggingReplica(prisma17, [{ model: "waitpoint", mode: "missing" }]);
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

      const seed = await seedEnvironment(prisma17, "dedicated", "wp_new");
      const runId = NEW_RUN_ID; // v1 body → NEW
      await newStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_wp_new",
          taskIdentifier: "my-task",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );
      const idempotencyKey = "wuik-new";
      await seedCompletedDateTimeWaitpoint(newStore, {
        id: `waitpoint_${generateRunOpsId()}`,
        friendlyId: "waitpoint_wp_new",
        projectId: seed.project.id,
        environmentId: seed.environment.id,
        idempotencyKey,
      });

      const found = await router.findWaitpoint(
        { where: { environmentId: seed.environment.id, idempotencyKey } },
        undefined,
        { coLocateWithRunId: runId }
      );

      expect(found).not.toBeNull();
      expect(found!.idempotencyKey).toBe(idempotencyKey);
      expect(found!.status).toBe("COMPLETED");
      expect(newReplica.wasHit()).toBe(false);
    }
  );

  // Guard: a NON-colocated, no-client findWaitpoint (no read-your-writes intent) still routes to the
  // replica — colocated dedup must not turn every waitpoint read into a primary read (that would defeat
  // replica offload).
  heteroRunOpsPostgresTest(
    "plain non-colocated reads still route to the replica (no read-your-writes escalation)",
    async ({ prisma14, prisma17 }) => {
      const legacyReplica = laggingReplica(prisma14, [{ model: "waitpoint", mode: "missing" }]);
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica.client,
        schemaVariant: "legacy",
      });
      const newReplica = laggingReplica(prisma17, [{ model: "waitpoint", mode: "missing" }]);
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: newReplica.client as never,
        schemaVariant: "dedicated",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      // No id, no colocation → the cross-DB scan probes each store's replica.
      const found = await router.findWaitpoint({
        where: { environmentId: "env_none", idempotencyKey: "does-not-exist" },
      });

      expect(found).toBeNull();
      // Both legs must be replica-probed — an `||` would hide a primary-routing regression on one leg.
      expect(legacyReplica.wasHit()).toBe(true);
      expect(newReplica.wasHit()).toBe(true);
    }
  );
});
