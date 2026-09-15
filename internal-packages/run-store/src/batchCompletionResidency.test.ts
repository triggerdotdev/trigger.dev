// REGRESSION suite for the run-ops split "control-plane tx/client forwarded into a NEW-resident
// store" bug class on the BatchTaskRun write/probe path. When the router resolves the owning store
// to #new but forwards the caller's control-plane handle, #new issues its statement against the
// CONTROL-PLANE DB where the run-ops id row does not exist → "No record was found" (update), wrong-DB row
// (create), or wrong count. Covers updateBatchTaskRun (commit 62ae880af), createBatchTaskRun and
// countBatchTaskRunItems (this sweep). `heteroRunOpsPostgresTest` is the REAL two-DB split topology
// (prisma17 = dedicated #new, prisma14 = legacy #legacy); NEVER mocked.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies by internal-id LENGTH (runOpsResidency.ts): 25 chars → cuid → LEGACY,
// a v1 body (26 chars, version "1" at index 25) → NEW.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / prisma14, full schema)
const NEW_ID_26 = "k".repeat(24) + "01"; // → NEW (#new / prisma17, dedicated subset schema)

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

// BatchTaskRunItem.taskRunId has an FK into TaskRun on the dedicated schema, so seed the referenced
// run before creating an item that points at it.
async function seedDedicatedRun(prisma17: RunOpsPrismaClient, envId: string, runId: string) {
  await prisma17.taskRun.create({
    data: {
      id: runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: `run_${runId}`,
      runtimeEnvironmentId: envId,
      environmentType: "DEVELOPMENT",
      organizationId: "org_cntitems_new",
      projectId: "proj_cntitems_new",
      taskIdentifier: "batch-task",
      payload: "{}",
      payloadType: "application/json",
      traceContext: {},
      traceId: `t_${runId}`,
      spanId: `s_${runId}`,
      queue: "task/batch-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
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

// Real production split topology: #new = dedicated subset on prisma17, #legacy = full schema on
// prisma14 — two physically distinct DBs.
function makeSplitRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyStore = makeLegacyStore(prisma14);
  const newStore = makeDedicatedStore(prisma17);
  return {
    router: new RoutingRunStore({ new: newStore, legacy: legacyStore }),
    legacyStore,
    newStore,
  };
}

describe("run-ops split — BatchTaskRun writes/probes must NOT forward the control-plane tx/client into NEW", () => {
  // ===========================================================================================
  // updateBatchTaskRun (commit 62ae880af) — the batch-completion residency regression.
  // ===========================================================================================

  // The live `batchSystem.#tryCompleteBatch` shape: a run-ops batch on #new is updated to COMPLETED
  // while the control-plane client is passed as `tx`. RED on the pre-62ae880af code (the router
  // forwarded tx → #new ran the UPDATE on the control-plane DB → "No record was found for an
  // update"); GREEN now (tx dropped for NEW → the row updates on #new's own DB).
  heteroRunOpsPostgresTest(
    "updateBatchTaskRun marks a run-ops batch on #new COMPLETED even when the control-plane client is passed as tx",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "updbatch_new");
      const batchId = `batch_${NEW_ID_26}`; // run-ops id → #new

      await prisma17.batchTaskRun.create({
        data: {
          id: batchId,
          friendlyId: "batch_upd_new",
          runtimeEnvironmentId: env.environment.id,
          runCount: 2,
          status: "PROCESSING",
        },
      });

      // Pass the LEGACY (control-plane) client as `tx`, EXACTLY as #tryCompleteBatch does.
      const updated = await router.updateBatchTaskRun(
        { where: { id: batchId }, data: { status: "COMPLETED" }, select: { id: true } },
        prisma14 as never
      );
      expect(updated.id).toBe(batchId);

      // The row on #new (its own DB) is genuinely COMPLETED — not a phantom update on the wrong DB.
      const onNew = await prisma17.batchTaskRun.findUnique({ where: { id: batchId } });
      expect(onNew?.status).toBe("COMPLETED");
    }
  );

  // Control: a cuid batch on #legacy still updates through the router when a client is passed as tx.
  // The caller's tx is dropped and the routed write runs on the legacy store's own client.
  heteroRunOpsPostgresTest(
    "updateBatchTaskRun control: a cuid batch on #legacy updates with the caller's tx dropped",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma14, "legacy", "updbatch_leg");
      const batchId = `batch_${CUID_25}`; // cuid → #legacy

      await prisma14.batchTaskRun.create({
        data: {
          id: batchId,
          friendlyId: "batch_upd_leg",
          runtimeEnvironmentId: env.environment.id,
          runCount: 1,
          status: "PROCESSING",
        },
      });

      const updated = await router.updateBatchTaskRun(
        { where: { id: batchId }, data: { status: "COMPLETED" }, select: { id: true } },
        prisma14 as never
      );
      expect(updated.id).toBe(batchId);
      const onLegacy = await prisma14.batchTaskRun.findUnique({ where: { id: batchId } });
      expect(onLegacy?.status).toBe("COMPLETED");
    }
  );

  // ===========================================================================================
  // createBatchTaskRun (this sweep) — same anti-pattern on the create path.
  // ===========================================================================================

  // A run-ops batch routed to #new with a forwarded control-plane tx must still be created on #new's
  // OWN DB, not the control-plane DB (which would strand the batch away from its co-resident child
  // runs/items). Forwarding tx unconditionally would land the row on prisma14.
  heteroRunOpsPostgresTest(
    "createBatchTaskRun lands a run-ops batch on #new even when the control-plane client is passed as tx",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "crbatch_new");
      const batchId = `batch_${NEW_ID_26}`; // run-ops id → #new

      const created = await router.createBatchTaskRun(
        {
          id: batchId,
          friendlyId: "batch_cr_new",
          runtimeEnvironmentId: env.environment.id,
          runCount: 1,
        },
        prisma14 as never // control-plane tx
      );
      expect(created.id).toBe(batchId);

      // Resident on #new (its own DB), absent from #legacy — co-located with its run-ops child runs.
      const onNew = await prisma17.batchTaskRun.findUnique({ where: { id: batchId } });
      expect(onNew).not.toBeNull();
      const onLegacy = await prisma14.batchTaskRun.findUnique({ where: { id: batchId } });
      expect(onLegacy).toBeNull();
    }
  );

  // Control: a cuid batch is created on #legacy with the caller's tx dropped — the routed create
  // runs on the legacy store's own client.
  heteroRunOpsPostgresTest(
    "createBatchTaskRun control: a cuid batch lands on #legacy with the caller's tx dropped",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma14, "legacy", "crbatch_leg");
      const batchId = `batch_${CUID_25}`; // cuid → #legacy

      const created = await router.createBatchTaskRun(
        {
          id: batchId,
          friendlyId: "batch_cr_leg",
          runtimeEnvironmentId: env.environment.id,
          runCount: 1,
        },
        prisma14 as never
      );
      expect(created.id).toBe(batchId);
      const onLegacy = await prisma14.batchTaskRun.findUnique({ where: { id: batchId } });
      expect(onLegacy).not.toBeNull();
      const onNew = await prisma17.batchTaskRun.findUnique({ where: { id: batchId } });
      expect(onNew).toBeNull();
    }
  );

  // ===========================================================================================
  // countBatchTaskRunItems (this sweep) — same anti-pattern on a routed probe read.
  // ===========================================================================================

  // A run-ops batch's items live on #new; counting them with the control-plane client forwarded would
  // count on the wrong DB (→ 0). The routed store must read its OWN DB and return the real count.
  heteroRunOpsPostgresTest(
    "countBatchTaskRunItems counts a run-ops batch's items on #new even when the control-plane client is passed",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "cntitems_new");
      const batchId = `batch_${NEW_ID_26}`; // run-ops id → #new

      await prisma17.batchTaskRun.create({
        data: {
          id: batchId,
          friendlyId: "batch_cnt_new",
          runtimeEnvironmentId: env.environment.id,
          runCount: 2,
          status: "PROCESSING",
        },
      });
      const runA = `run_${NEW_ID_26.slice(0, -3)}ra1`;
      const runB = `run_${NEW_ID_26.slice(0, -3)}rb1`;
      await seedDedicatedRun(prisma17, env.environment.id, runA);
      await seedDedicatedRun(prisma17, env.environment.id, runB);
      await prisma17.batchTaskRunItem.create({
        data: { batchTaskRunId: batchId, taskRunId: runA, status: "COMPLETED" },
      });
      await prisma17.batchTaskRunItem.create({
        data: { batchTaskRunId: batchId, taskRunId: runB, status: "PENDING" },
      });

      // Pass the LEGACY (control-plane) client; the routed #new store must ignore it and read its own DB.
      expect(
        await router.countBatchTaskRunItems({ batchTaskRunId: batchId }, prisma14 as never)
      ).toBe(2);
      expect(
        await router.countBatchTaskRunItems(
          { batchTaskRunId: batchId, status: "COMPLETED" },
          prisma14 as never
        )
      ).toBe(1);
    }
  );
});
