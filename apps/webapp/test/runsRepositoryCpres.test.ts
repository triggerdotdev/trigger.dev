import { describe, expect, vi } from "vitest";

// The runsRepository module graph imports `~/v3/runStore.server`, which imports `~/db.server`
// at load. Stub it (the existing runsRepository.*.test.ts do the same) — the function under
// test is driven entirely through a RunStore built from the injected real containers, never
// the stubbed module singletons.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import { buildRunStore } from "~/v3/runStore.server";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import type { PrismaClient } from "@trigger.dev/database";
import { BulkActionId, RunId } from "@trigger.dev/core/v3/isomorphic";
import { convertRunListInputOptionsToFilterRunsOptions } from "~/services/runsRepository/runsRepository.server";

vi.setConfig({ testTimeout: 90_000 });

type SeedContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

/** Seeds org/project/env parents on the control-plane client. */
async function seedParents(prisma: PrismaClient, slug: string): Promise<SeedContext> {
  const organization = await prisma.organization.create({
    data: { title: `org-${slug}`, slug: `org-${slug}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: organization.id,
      externalRef: `proj-${slug}`,
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slug}`,
      pkApiKey: `pk_dev_${slug}`,
      shortcode: `sc-${slug}`,
    },
  });

  return {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: runtimeEnvironment.id,
  };
}

/** A batch on the NEW (dedicated run-ops) DB — the residency the single control-plane client silently missed. */
async function seedNewBatch(
  prisma: RunOpsPrismaClient,
  friendlyId: string,
  runtimeEnvironmentId: string
) {
  return prisma.batchTaskRun.create({ data: { friendlyId, runtimeEnvironmentId } });
}

/** A batch on the LEGACY (control-plane) DB. */
async function seedLegacyBatch(
  prisma: PrismaClient,
  friendlyId: string,
  runtimeEnvironmentId: string
) {
  return prisma.batchTaskRun.create({ data: { friendlyId, runtimeEnvironmentId } });
}

async function seedSchedule(prisma: PrismaClient, friendlyId: string, projectId: string) {
  return prisma.taskSchedule.create({
    data: { friendlyId, projectId, taskIdentifier: "my-task", generatorExpression: "* * * * *" },
  });
}

describe("convertRunListInputOptionsToFilterRunsOptions cross-DB filter resolution (control-plane + run-ops)", () => {
  // --- A NEW-resident batch must resolve via the store's NEW->LEGACY probe ---
  // Previously the single control-plane client missed it, leaving the friendlyId in the
  // ClickHouse `batch_id` filter -> zero runs. Schedule (control-plane) resolves off prisma14.
  heteroRunOpsPostgresTest(
    "split: a NEW-resident batch resolves via the run-ops store; schedule resolves on control-plane",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "test1");

      const batch = await seedNewBatch(prisma17, "batch_test1", ctx.environmentId);
      const schedule = await seedSchedule(prisma14, "sched_test1", ctx.projectId);

      const store = buildRunStore({
        splitEnabled: true,
        newWriter: prisma17,
        newReplica: prisma17,
        legacyWriter: prisma14,
        legacyReplica: prisma14,
        singleWriter: prisma14,
        singleReplica: prisma14,
      });

      const result = await convertRunListInputOptionsToFilterRunsOptions(
        {
          organizationId: ctx.organizationId,
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
          batchId: "batch_test1",
          scheduleId: "sched_test1",
        },
        prisma14, // control-plane client (used for the schedule lookup)
        store
      );

      expect(result.batchId).toBe(batch.id);
      expect(result.scheduleId).toBe(schedule.id);
    }
  );

  // --- A LEGACY-resident batch still resolves via the NEW->LEGACY fallback ---
  heteroRunOpsPostgresTest(
    "split: a LEGACY-resident batch resolves via the store's legacy fallback",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "test2");

      const batch = await seedLegacyBatch(prisma14, "batch_test2", ctx.environmentId);

      const store = buildRunStore({
        splitEnabled: true,
        newWriter: prisma17,
        newReplica: prisma17,
        legacyWriter: prisma14,
        legacyReplica: prisma14,
        singleWriter: prisma14,
        singleReplica: prisma14,
      });

      const result = await convertRunListInputOptionsToFilterRunsOptions(
        {
          organizationId: ctx.organizationId,
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
          batchId: "batch_test2",
        },
        prisma14,
        store
      );

      expect(result.batchId).toBe(batch.id);
    }
  );

  // --- An unknown batch friendlyId is retained unchanged (no spurious match) ---
  heteroRunOpsPostgresTest(
    "split: an unknown batch friendlyId is retained (resolves on neither DB)",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "test2b");

      const store = buildRunStore({
        splitEnabled: true,
        newWriter: prisma17,
        newReplica: prisma17,
        legacyWriter: prisma14,
        legacyReplica: prisma14,
        singleWriter: prisma14,
        singleReplica: prisma14,
      });

      const result = await convertRunListInputOptionsToFilterRunsOptions(
        {
          organizationId: ctx.organizationId,
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
          batchId: "batch_missing",
        },
        prisma14,
        store
      );

      expect(result.batchId).toBe("batch_missing");
    }
  );

  // --- Single-DB passthrough: a passthrough store resolves the batch off the one client ---
  heteroRunOpsPostgresTest(
    "single-DB passthrough: the batch + schedule resolve off the one client",
    async ({ prisma14 }) => {
      const ctx = await seedParents(prisma14, "test3");
      const batch = await seedLegacyBatch(prisma14, "batch_test3", ctx.environmentId);
      const schedule = await seedSchedule(prisma14, "sched_test3", ctx.projectId);

      const store = buildRunStore({
        splitEnabled: false,
        singleWriter: prisma14,
        singleReplica: prisma14,
      });

      const result = await convertRunListInputOptionsToFilterRunsOptions(
        {
          organizationId: ctx.organizationId,
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
          batchId: "batch_test3",
          scheduleId: "sched_test3",
        },
        prisma14,
        store
      );

      expect(result.batchId).toBe(batch.id);
      expect(result.scheduleId).toBe(schedule.id);
    }
  );

  // --- Pure-conversion non-regression (period, bulkId, runId, rootOnly) ---
  heteroRunOpsPostgresTest(
    "pure conversions unchanged: period, bulkId, runId, rootOnly in a single-DB call",
    async ({ prisma14 }) => {
      const ctx = await seedParents(prisma14, "test4");
      const batch = await seedLegacyBatch(prisma14, "batch_test4", ctx.environmentId);

      const bulkFriendly = BulkActionId.generate().friendlyId; // real "bulk_..." friendlyId
      const internalRunId = RunId.generate().id; // internal id to be converted to a friendlyId

      const store = buildRunStore({
        splitEnabled: false,
        singleWriter: prisma14,
        singleReplica: prisma14,
      });

      const result = await convertRunListInputOptionsToFilterRunsOptions(
        {
          organizationId: ctx.organizationId,
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
          period: "1h",
          bulkId: bulkFriendly,
          runId: [internalRunId],
          batchId: "batch_test4",
          rootOnly: true,
        },
        prisma14,
        store
      );

      // period: "1h" -> 3600000 ms via parseDuration.
      expect(result.period).toBe(3600000);
      // bulkId: round-tripped through BulkActionId.toId.
      expect(result.bulkId).toBe(BulkActionId.toId(bulkFriendly));
      // runId: each element mapped via RunId.toFriendlyId.
      expect(result.runId).toEqual([RunId.toFriendlyId(internalRunId)]);
      // batchId still resolved off the single client.
      expect(result.batchId).toBe(batch.id);
      // rootOnly forced false because batchId/runId are present (even though caller passed true).
      expect(result.rootOnly).toBe(false);
    }
  );
});
