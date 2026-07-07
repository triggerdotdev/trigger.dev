import { heteroPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import { isUniqueConstraintError, type PrismaClient } from "@trigger.dev/database";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

// Proves BatchTriggerV3's three store seams (cached-run lookup, expired-key clear,
// membership write) route correctly against real PG14 (legacy) + PG17 (run-ops)
// containers, using the service's exact query shapes. The service methods are
// JS #-private, so the seam is driven directly — same approach as the sibling
// legacy-authority test.

async function seedOrgProjectEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `test-${suffix}`, slug: `test-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `test-${suffix}`,
      slug: `test-${suffix}`,
      organizationId: organization.id,
      externalRef: `test-${suffix}`,
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `test-${suffix}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `test-${suffix}`,
      pkApiKey: `test-${suffix}`,
      shortcode: `test-${suffix}`,
    },
  });
  return { organization, project, runtimeEnvironment };
}

async function seedRun(
  prisma: PrismaClient,
  args: {
    runtimeEnvironmentId: string;
    projectId: string;
    organizationId: string;
    taskIdentifier: string;
    idempotencyKey?: string;
    status?: "PENDING" | "EXECUTING" | "COMPLETED_SUCCESSFULLY" | "COMPLETED_WITH_ERRORS";
    idempotencyKeyExpiresAt?: Date;
  }
) {
  const runId = generateRunOpsId();
  return prisma.taskRun.create({
    data: {
      id: runId,
      friendlyId: `run_${runId}`,
      taskIdentifier: args.taskIdentifier,
      idempotencyKey: args.idempotencyKey ?? null,
      idempotencyKeyExpiresAt: args.idempotencyKeyExpiresAt ?? null,
      status: args.status ?? "EXECUTING",
      payload: JSON.stringify({ foo: "bar" }),
      payloadType: "application/json",
      traceId: "1234",
      spanId: "1234",
      queue: "test",
      runtimeEnvironmentId: args.runtimeEnvironmentId,
      projectId: args.projectId,
      organizationId: args.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
    },
  });
}

async function seedBatch(prisma: PrismaClient, runtimeEnvironmentId: string, suffix: string) {
  const batchId = generateRunOpsId();
  return prisma.batchTaskRun.create({
    data: {
      id: batchId,
      friendlyId: `batch_${suffix}_${batchId}`,
      runtimeEnvironmentId,
    },
  });
}

describe("BatchTriggerV3 · store-seam routing (cross-DB)", () => {
  heteroPostgresTest(
    "(A) cached-run reuse resolves via the legacy (PG14) authority; a PG17-only key is invisible",
    async ({ prisma14, prisma17 }) => {
      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma14,
        "batch-cached"
      );
      const newSide = await seedOrgProjectEnv(prisma17, "batch-cached-new");

      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const key1 = "idem-batch-1";
      const key2 = "idem-batch-2";
      const freshKey = "idem-batch-fresh";

      const run1 = await seedRun(prisma14, {
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        taskIdentifier: "my-task",
        idempotencyKey: key1,
      });
      const run2 = await seedRun(prisma14, {
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        taskIdentifier: "my-task",
        idempotencyKey: key2,
      });

      // A row with one of the SAME keys lives only on PG17 (run-ops). The
      // legacy-pinned read must NOT see it.
      await seedRun(prisma17, {
        runtimeEnvironmentId: newSide.runtimeEnvironment.id,
        projectId: newSide.project.id,
        organizationId: newSide.organization.id,
        taskIdentifier: "my-task",
        idempotencyKey: key1,
      });

      // The service's exact cached-run query shape, pinned to PG14.
      const cachedRuns = await legacyStore.findRuns(
        {
          where: {
            runtimeEnvironmentId: runtimeEnvironment.id,
            taskIdentifier: "my-task",
            idempotencyKey: { in: [key1, key2, freshKey] },
          },
          select: {
            friendlyId: true,
            idempotencyKey: true,
            idempotencyKeyExpiresAt: true,
          },
        },
        prisma14
      );

      // Exactly the 2 seeded rows; the fresh key matches nothing.
      expect(cachedRuns).toHaveLength(2);
      const friendlyIds = cachedRuns.map((r) => r.friendlyId).sort();
      expect(friendlyIds).toEqual([run1.friendlyId, run2.friendlyId].sort());
      // Each friendlyId distinct, exactly one row per seeded key.
      expect(new Set(friendlyIds).size).toBe(2);
      expect(cachedRuns.filter((r) => r.idempotencyKey === key1)).toHaveLength(1);
      expect(cachedRuns.filter((r) => r.idempotencyKey === key2)).toHaveLength(1);
    }
  );

  heteroPostgresTest(
    "(B) expired-key clear is routed to the legacy (PG14) authority and does not touch PG17",
    async ({ prisma14, prisma17 }) => {
      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma14,
        "batch-expired"
      );
      const newSide = await seedOrgProjectEnv(prisma17, "batch-expired-new");

      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const expiredKey = "idem-batch-expired";

      const legacyRun = await seedRun(prisma14, {
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        taskIdentifier: "my-task",
        idempotencyKey: expiredKey,
        idempotencyKeyExpiresAt: new Date(Date.now() - 60_000),
      });

      // A PG17 row with the same key, to prove the clear does not reach it.
      const newRun = await seedRun(prisma17, {
        runtimeEnvironmentId: newSide.runtimeEnvironment.id,
        projectId: newSide.project.id,
        organizationId: newSide.organization.id,
        taskIdentifier: "my-task",
        idempotencyKey: expiredKey,
      });

      // The service's exact expired-key clear shape, pinned to PG14.
      await legacyStore.clearIdempotencyKey({ byFriendlyIds: [legacyRun.friendlyId] }, prisma14);

      const cleared = await prisma14.taskRun.findFirst({ where: { id: legacyRun.id } });
      expect(cleared?.idempotencyKey).toBeNull();

      // The PG17 row is untouched.
      const untouched = await prisma17.taskRun.findFirst({ where: { id: newRun.id } });
      expect(untouched?.idempotencyKey).toBe(expiredKey);
    }
  );

  heteroPostgresTest(
    "(C) membership write lands on the run-ops (PG17) store; duplicate raises a unique-constraint error",
    async ({ prisma17 }) => {
      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma17,
        "batch-membership"
      );

      const runOpsStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });

      const batch = await seedBatch(prisma17, runtimeEnvironment.id, "membership");
      const run = await seedRun(prisma17, {
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        taskIdentifier: "my-task",
      });

      await runOpsStore.createBatchTaskRunItem({
        batchTaskRunId: batch.id,
        taskRunId: run.id,
        status: "PENDING",
      });

      const item = await prisma17.batchTaskRunItem.findFirst({
        where: { batchTaskRunId: batch.id, taskRunId: run.id },
      });
      expect(item).not.toBeNull();
      expect(item?.status).toBe("PENDING");

      // Re-calling with the SAME pair raises a unique-constraint error at the
      // store layer (the service's try/catch is what swallows it).
      let caught: unknown;
      try {
        await runOpsStore.createBatchTaskRunItem({
          batchTaskRunId: batch.id,
          taskRunId: run.id,
          status: "PENDING",
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      expect(isUniqueConstraintError(caught, ["batchTaskRunId", "taskRunId"])).toBe(true);

      // Still exactly one row.
      const count = await prisma17.batchTaskRunItem.count({
        where: { batchTaskRunId: batch.id, taskRunId: run.id },
      });
      expect(count).toBe(1);
    }
  );
});
