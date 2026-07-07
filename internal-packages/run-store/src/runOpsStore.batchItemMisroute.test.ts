// updateManyBatchTaskRunItems routed by where.id first, but BatchTaskRunItem.id is a cuid (always
// classifies LEGACY). For a NEW-residency batch the items live on #new, so completing an item by
// {id, batchTaskRunId, status} updated #legacy, matched 0 rows, and the caller treated count===0 as
// "already completed" -> tryCompleteBatchV3 never fired -> the item stayed PENDING and the parent's
// batchTriggerAndWait hung. Fix: route by batchTaskRunId (residency-encoding) first, like
// countBatchTaskRunItems. Real two-DB topology; never mocked.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

const NEW_ID_26 = "k".repeat(24) + "01"; // run-ops id -> NEW (#new / prisma17)

function makeSplitRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
  });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

// BatchTaskRunItem.taskRunId FKs into TaskRun on the dedicated schema, so seed the run first.
async function seedDedicatedRun(prisma17: RunOpsPrismaClient, envId: string, runId: string) {
  await prisma17.taskRun.create({
    data: {
      id: runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: `run_${runId}`,
      runtimeEnvironmentId: envId,
      environmentType: "DEVELOPMENT",
      organizationId: "org_batchitem",
      projectId: "proj_batchitem",
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

describe("run-ops split — completing a batch item routes by the batch id, not the item cuid", () => {
  heteroRunOpsPostgresTest(
    "updateManyBatchTaskRunItems completes a NEW-resident item addressed by {id, batchTaskRunId}",
    async ({ prisma14, prisma17 }: { prisma14: PrismaClient; prisma17: RunOpsPrismaClient }) => {
      const router = makeSplitRouter(prisma14, prisma17);
      const envId = "env_batchitem";
      const batchId = `batch_${NEW_ID_26}`; // run-ops id -> #new
      const runId = `run_${NEW_ID_26.slice(0, -3)}ri1`;

      await prisma17.batchTaskRun.create({
        data: {
          id: batchId,
          friendlyId: "batch_item_new",
          runtimeEnvironmentId: envId,
          runCount: 1,
          status: "PROCESSING",
        },
      });
      await seedDedicatedRun(prisma17, envId, runId);
      // item.id is an auto cuid (classifies LEGACY) — the mis-routing key, exactly as in production.
      const item = await prisma17.batchTaskRunItem.create({
        data: { batchTaskRunId: batchId, taskRunId: runId, status: "PENDING" },
      });

      const result = await router.updateManyBatchTaskRunItems({
        where: { id: item.id, batchTaskRunId: batchId, status: "PENDING" },
        data: { status: "COMPLETED" },
      });

      // RED: routed by the item cuid -> #legacy -> 0 rows -> batch never completes -> parent hangs.
      // GREEN: routed by batchTaskRunId (NEW) -> #new -> the item completes.
      expect(result.count).toBe(1);
      const onNew = await prisma17.batchTaskRunItem.findUnique({ where: { id: item.id } });
      expect(onNew?.status).toBe("COMPLETED");
      // Legacy was never touched: no phantom/double-routed item update on #legacy.
      expect(await prisma14.batchTaskRunItem.count({ where: { batchTaskRunId: batchId } })).toBe(0);
    }
  );

  // createBatchTaskRunItem must co-locate the item with its BATCH (so the completion count, routed by
  // batchTaskRunId, finds it), not with the child run. Routing by taskRunId would place a divergent-
  // residency item on the child's DB -> invisible to the count -> the batch never completes -> parent hangs.
  heteroRunOpsPostgresTest(
    "createBatchTaskRunItem places the item on the batch's DB, routing by batchTaskRunId not taskRunId",
    async ({ prisma14, prisma17 }: { prisma14: PrismaClient; prisma17: RunOpsPrismaClient }) => {
      const router = makeSplitRouter(prisma14, prisma17);
      const envId = "env_batchitem";
      const batchId = `batch_${NEW_ID_26}`; // run-ops id -> #new
      const runId = "c".repeat(25); // cuid -> classifies LEGACY (the divergent routing key)

      await prisma17.batchTaskRun.create({
        data: {
          id: batchId,
          friendlyId: "batch_create_new",
          runtimeEnvironmentId: envId,
          runCount: 1,
          status: "PROCESSING",
        },
      });
      // The run physically lives on #new (the batch's DB) so the item's FKs resolve there.
      await seedDedicatedRun(prisma17, envId, runId);

      await router.createBatchTaskRunItem({
        batchTaskRunId: batchId,
        taskRunId: runId,
        status: "PENDING",
      });

      // GREEN: routed by batchTaskRunId (NEW) -> item on #new, visible to the batch-completion count.
      // RED: routed by the cuid taskRunId -> #legacy -> the create FK-fails / the count never sees it.
      expect(await prisma17.batchTaskRunItem.count({ where: { batchTaskRunId: batchId } })).toBe(1);
      expect(await prisma14.batchTaskRunItem.count({ where: { batchTaskRunId: batchId } })).toBe(0);
    }
  );
});
