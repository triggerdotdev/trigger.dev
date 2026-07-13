// Flow-level seam proof for ApiBatchResultsPresenter, ABOVE the run-store-level coverage in
// internal-packages/run-store (batchItemMisroute, batchCompletionResidency). Proves the batch
// RESULTS READ assembles correctly when one batch's members are genuinely split across the real
// dedicated run-ops subset schema (prisma17 / RunOpsPrismaClient) and the full control-plane
// schema (prisma14) — not a mirrored full schema on both sides. No mocks.
import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import type { PrismaClient } from "@trigger.dev/database";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";
import type { PrismaReplicaClient } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ApiBatchResultsPresenter } from "~/presenters/v3/ApiBatchResultsPresenter.server";

vi.setConfig({ testTimeout: 60_000 });

// A prisma handle that throws on any access — proves the passthrough constructor args are never
// touched on the split path.
const throwingPrisma = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(
        `passthrough handle must not be touched on the split path (got .${String(prop)})`
      );
    },
  }
) as unknown as PrismaReplicaClient;

// 25-char cuid-shaped id, no v1 version marker at index 25 -> classifies LEGACY.
function generateLegacyCuid(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const suffix = Array.from({ length: 24 }, () => alphabet[Math.floor(Math.random() * 36)]).join(
    ""
  );
  return `c${suffix}`;
}

let seedCounter = 0;

// TaskRun on the full control-plane schema has real FKs into RuntimeEnvironment/Project.
async function seedLegacyEnv(prisma14: PrismaClient, slug: string) {
  const n = seedCounter++;
  const organization = await prisma14.organization.create({
    data: { title: `Org ${slug}`, slug: `org-${slug}-${n}` },
  });
  const project = await prisma14.project.create({
    data: {
      name: `Proj ${slug}`,
      slug: `proj-${slug}-${n}`,
      organizationId: organization.id,
      externalRef: `ext-${slug}-${n}`,
    },
  });
  const environment = await prisma14.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}-${n}`,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `api-${slug}-${n}`,
      pkApiKey: `pk-${slug}-${n}`,
      shortcode: `sc-${slug}-${n}`,
    },
  });
  return { organization, project, environment };
}

type SeedCtx = Awaited<ReturnType<typeof seedLegacyEnv>>;

type MemberSeed = {
  id: string;
  friendlyId: string;
  status: "COMPLETED_SUCCESSFULLY" | "COMPLETED_WITH_ERRORS";
  output?: string;
  error?: unknown;
};

// Drop the TaskRunAttempt worker/queue FKs so attempts can be seeded without standing up
// BackgroundWorker/TaskQueue parents — incidental to this read path.
async function relaxLegacyAttemptFk(prisma14: PrismaClient) {
  for (const sql of [
    `ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_backgroundWorkerId_fkey"`,
    `ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_backgroundWorkerTaskId_fkey"`,
    `ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_queueId_fkey"`,
  ]) {
    await prisma14.$executeRawUnsafe(sql);
  }
}

async function seedLegacyMember(prisma14: PrismaClient, ctx: SeedCtx, m: MemberSeed) {
  const run = await prisma14.taskRun.create({
    data: {
      id: m.id,
      friendlyId: m.friendlyId,
      taskIdentifier: "my-task",
      status: m.status,
      payload: JSON.stringify({}),
      payloadType: "application/json",
      traceId: m.id,
      spanId: m.id,
      queue: "main",
      runtimeEnvironmentId: ctx.environment.id,
      projectId: ctx.project.id,
      organizationId: ctx.organization.id,
      environmentType: "PRODUCTION",
      engine: "V2",
    },
  });

  await prisma14.taskRunAttempt.create({
    data: {
      friendlyId: `attempt_${m.id}`,
      number: 1,
      taskRunId: run.id,
      backgroundWorkerId: "bw",
      backgroundWorkerTaskId: "bwt",
      runtimeEnvironmentId: ctx.environment.id,
      queueId: "q",
      status: m.status === "COMPLETED_SUCCESSFULLY" ? "COMPLETED" : "FAILED",
      output: m.output,
      outputType: "application/json",
      error: m.error as any,
    },
  });

  return run;
}

// TaskRun/TaskRunAttempt on the DEDICATED (run-ops subset) schema: runtimeEnvironmentId,
// organizationId, projectId, backgroundWorkerId/backgroundWorkerTaskId/queueId are all
// scalar-only there (no real relation) — no parent rows to seed, unlike the legacy side.
async function seedNewMember(
  prisma17: RunOpsPrismaClient,
  ctx: { envId: string; orgId: string; projectId: string },
  m: MemberSeed
) {
  await prisma17.taskRun.create({
    data: {
      id: m.id,
      engine: "V2",
      status: m.status,
      friendlyId: m.friendlyId,
      runtimeEnvironmentId: ctx.envId,
      environmentType: "PRODUCTION",
      organizationId: ctx.orgId,
      projectId: ctx.projectId,
      taskIdentifier: "my-task",
      payload: JSON.stringify({}),
      payloadType: "application/json",
      traceContext: {},
      traceId: m.id,
      spanId: m.id,
      queue: "main",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
    },
  });

  await prisma17.taskRunAttempt.create({
    data: {
      friendlyId: `attempt_${m.id}`,
      number: 1,
      taskRunId: m.id,
      backgroundWorkerId: "bw",
      backgroundWorkerTaskId: "bwt",
      runtimeEnvironmentId: ctx.envId,
      queueId: "q",
      status: m.status === "COMPLETED_SUCCESSFULLY" ? "COMPLETED" : "FAILED",
      output: m.output,
      outputType: "application/json",
      error: m.error as any,
    },
  });
}

// BatchTaskRunItem.taskRunId is a real FK to TaskRun on the dedicated schema too. A batch seeded
// on the dedicated DB whose items reference a LEGACY-resident (or wholly missing) member has no
// local row for that member — drop the FK so the cross-seam item row can exist, matching the
// physical reality of a split batch.
async function relaxNewBatchItemFk(prisma17: RunOpsPrismaClient) {
  await prisma17.$executeRawUnsafe(
    `ALTER TABLE "BatchTaskRunItem" DROP CONSTRAINT IF EXISTS "BatchTaskRunItem_taskRunId_fkey"`
  );
}

async function seedBatchOnNew(
  prisma17: RunOpsPrismaClient,
  envId: string,
  friendlyId: string,
  memberIds: string[]
) {
  const batch = await prisma17.batchTaskRun.create({
    data: {
      friendlyId,
      runtimeEnvironmentId: envId,
      runCount: memberIds.length,
      runIds: [],
      batchVersion: "runengine:v2",
    },
  });
  // Items in a deterministic order so the result `items` order is assertable.
  for (const taskRunId of memberIds) {
    await prisma17.batchTaskRunItem.create({
      data: { batchTaskRunId: batch.id, taskRunId, status: "COMPLETED" },
    });
  }
  return batch;
}

const env = (ctx: SeedCtx) =>
  ({
    id: ctx.environment.id,
    type: ctx.environment.type,
    slug: ctx.environment.slug,
    organizationId: ctx.organization.id,
    organization: { slug: ctx.organization.slug, title: ctx.organization.title },
    projectId: ctx.project.id,
    project: { name: ctx.project.name },
  }) as unknown as AuthenticatedEnvironment;

describe("ApiBatchResultsPresenter split mode — real run-ops dedicated schema seam", () => {
  // The core assembly proof: one batch, members genuinely split across the two physically
  // distinct, differently-shaped DBs (dedicated subset vs full control-plane).
  heteroRunOpsPostgresTest(
    "a batch with members split across the dedicated NEW schema and the legacy schema returns the complete union",
    async ({ prisma14, prisma17 }: { prisma14: PrismaClient; prisma17: RunOpsPrismaClient }) => {
      const ctx = await seedLegacyEnv(prisma14, "split-new-legacy");
      await relaxLegacyAttemptFk(prisma14);
      await relaxNewBatchItemFk(prisma17);

      const newMemberId = generateRunOpsId();
      expect(newMemberId.length).toBe(26);
      const legacyMemberId = generateLegacyCuid();
      expect(legacyMemberId.length).toBe(25);

      // NEW-resident member: lives ONLY on the dedicated run-ops schema (prisma17).
      await seedNewMember(
        prisma17,
        { envId: ctx.environment.id, orgId: ctx.organization.id, projectId: ctx.project.id },
        {
          id: newMemberId,
          friendlyId: "run_new_member",
          status: "COMPLETED_SUCCESSFULLY",
          output: JSON.stringify({ from: "new" }),
        }
      );

      // LEGACY-resident member: lives ONLY on the full control-plane schema (prisma14).
      await seedLegacyMember(prisma14, ctx, {
        id: legacyMemberId,
        friendlyId: "run_legacy_member",
        status: "COMPLETED_WITH_ERRORS",
        error: { type: "BUILT_IN_ERROR", name: "Err", message: "boom", stackTrace: "" },
      });

      // The batch row + items live on the NEW dedicated DB; items reference both members.
      const batchFriendlyId = "batch_split_seam";
      await seedBatchOnNew(prisma17, ctx.environment.id, batchFriendlyId, [
        newMemberId,
        legacyMemberId,
      ]);

      const presenter = new ApiBatchResultsPresenter(throwingPrisma, throwingPrisma, {
        splitEnabled: true,
        newClient: prisma17 as unknown as PrismaReplicaClient,
        legacyReplica: prisma14 as unknown as PrismaReplicaClient,
      });

      const result = await presenter.call(batchFriendlyId, env(ctx));

      expect(result).toBeDefined();
      expect(result!.id).toBe(batchFriendlyId);
      expect(result!.items).toHaveLength(2);

      // Order follows item order: the NEW-resident member first, the legacy-resident second.
      const [first, second] = result!.items;
      expect(first).toEqual({
        ok: true,
        id: "run_new_member",
        taskIdentifier: "my-task",
        output: JSON.stringify({ from: "new" }),
        outputType: "application/json",
      });
      expect(second).toMatchObject({
        ok: false,
        id: "run_legacy_member",
        taskIdentifier: "my-task",
      });
    }
  );

  // Dangling member: an item id that resolves on NEITHER the dedicated NEW schema nor the legacy
  // schema must be dropped from the result, not thrown — the presenter degrades to the reachable
  // set. Give the missing id a legacy shape so it also exercises the "not NEW-shaped -> legacy
  // candidate" branch, proving the legacy probe finding nothing doesn't throw either.
  heteroRunOpsPostgresTest(
    "a member id that resolves on neither the dedicated NEW schema nor the legacy schema is dropped, not thrown",
    async ({ prisma14, prisma17 }: { prisma14: PrismaClient; prisma17: RunOpsPrismaClient }) => {
      const ctx = await seedLegacyEnv(prisma14, "dangling");
      await relaxNewBatchItemFk(prisma17);

      const presentId = generateRunOpsId();
      const missingId = generateLegacyCuid(); // referenced by an item but seeded on NEITHER DB

      await seedNewMember(
        prisma17,
        { envId: ctx.environment.id, orgId: ctx.organization.id, projectId: ctx.project.id },
        {
          id: presentId,
          friendlyId: "run_present",
          status: "COMPLETED_SUCCESSFULLY",
          output: JSON.stringify({ present: true }),
        }
      );

      const batchFriendlyId = "batch_dangling_seam";
      await seedBatchOnNew(prisma17, ctx.environment.id, batchFriendlyId, [presentId, missingId]);

      const presenter = new ApiBatchResultsPresenter(throwingPrisma, throwingPrisma, {
        splitEnabled: true,
        newClient: prisma17 as unknown as PrismaReplicaClient,
        legacyReplica: prisma14 as unknown as PrismaReplicaClient,
      });

      const result = await presenter.call(batchFriendlyId, env(ctx));

      expect(result).toBeDefined();
      expect(result!.id).toBe(batchFriendlyId);
      // The dangling member is silently dropped; the reachable member still returns — the call
      // must not throw despite the item referencing a run absent from both physical DBs.
      expect(result!.items).toHaveLength(1);
      expect(result!.items[0]).toMatchObject({ ok: true, id: "run_present" });
    }
  );
});
