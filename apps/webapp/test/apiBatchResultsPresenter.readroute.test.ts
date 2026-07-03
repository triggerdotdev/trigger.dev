// Route-level regression for ApiBatchResultsPresenter: the /batches/:id/results route used to build
// the presenter with no read-through deps, collapsing to a passthrough read off the control-plane
// replica only, which 404s a NEW-resident (ksuid) batch that lives on the dedicated run-ops DB.
import { heteroPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import type { PrismaReplicaClient } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ApiBatchResultsPresenter } from "~/presenters/v3/ApiBatchResultsPresenter.server";

vi.setConfig({ testTimeout: 60_000 });

// 27-char body → NEW residency (ksuid analog). 25-char body → LEGACY residency (cuid analog).
function newRunId(c: string) {
  return c.repeat(27);
}

// A prisma handle that throws on any access — proves the split path never reads the passthrough
// handles when the batch resolves off the NEW client.
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

let seedCounter = 0;

async function seedEnv(prisma: PrismaClient, slug: string) {
  const n = seedCounter++;
  const organization = await prisma.organization.create({
    data: { title: `Org ${slug}`, slug: `org-${slug}-${n}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Proj ${slug}`,
      slug: `proj-${slug}-${n}`,
      organizationId: organization.id,
      externalRef: `ext-${slug}-${n}`,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
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

type SeedCtx = Awaited<ReturnType<typeof seedEnv>>;

// Mirror the same org/project/env ids onto the second DB so a passthrough read against the
// control-plane replica has the environment row to filter on (but NOT the batch row).
async function mirrorEnv(prisma: PrismaClient, ctx: SeedCtx, slug: string) {
  const n = seedCounter++;
  await prisma.organization.create({
    data: { id: ctx.organization.id, title: `Org ${slug}`, slug: `org-${slug}-m-${n}` },
  });
  await prisma.project.create({
    data: {
      id: ctx.project.id,
      name: `Proj ${slug}`,
      slug: `proj-${slug}-m-${n}`,
      organizationId: ctx.organization.id,
      externalRef: `ext-${slug}-m-${n}`,
    },
  });
  await prisma.runtimeEnvironment.create({
    data: {
      id: ctx.environment.id,
      slug: `env-${slug}-m-${n}`,
      type: "PRODUCTION",
      projectId: ctx.project.id,
      organizationId: ctx.organization.id,
      apiKey: `api-${slug}-m-${n}`,
      pkApiKey: `pk-${slug}-m-${n}`,
      shortcode: `sc-${slug}-m-${n}`,
    },
  });
}

// Drop the per-DB TaskRunAttempt worker/queue FKs so we can seed an attempt (its output is what the
// execution-result carries) without standing up BackgroundWorker/TaskQueue parents.
async function relaxFks(prisma: PrismaClient) {
  for (const sql of [
    `ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_backgroundWorkerId_fkey"`,
    `ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_backgroundWorkerTaskId_fkey"`,
    `ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_queueId_fkey"`,
  ]) {
    await prisma.$executeRawUnsafe(sql);
  }
}

async function seedMember(
  prisma: PrismaClient,
  ctx: SeedCtx,
  m: { id: string; friendlyId: string; output: string }
) {
  const run = await prisma.taskRun.create({
    data: {
      id: m.id,
      friendlyId: m.friendlyId,
      taskIdentifier: "my-task",
      status: "COMPLETED_SUCCESSFULLY",
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

  await prisma.taskRunAttempt.create({
    data: {
      friendlyId: `attempt_${m.id}`,
      number: 1,
      taskRunId: run.id,
      backgroundWorkerId: "bw",
      backgroundWorkerTaskId: "bwt",
      runtimeEnvironmentId: ctx.environment.id,
      queueId: "q",
      status: "COMPLETED",
      output: m.output,
      outputType: "application/json",
    },
  });

  return run;
}

async function seedBatch(
  prisma: PrismaClient,
  ctx: SeedCtx,
  friendlyId: string,
  memberIds: string[]
) {
  const batch = await prisma.batchTaskRun.create({
    data: {
      friendlyId,
      runtimeEnvironmentId: ctx.environment.id,
      runCount: memberIds.length,
      runIds: [],
      batchVersion: "runengine:v2",
    },
  });
  for (const taskRunId of memberIds) {
    await prisma.batchTaskRunItem.create({
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

describe("ApiBatchResultsPresenter route wiring (the /batches/:id/results 404 regression)", () => {
  heteroPostgresTest(
    "a NEW-resident batch resolves with split deps but 404s (undefined) when built passthrough-only",
    async ({ prisma14, prisma17 }) => {
      const newDb = prisma17 as unknown as PrismaClient; // dedicated run-ops (NEW) DB analog
      const legacyDb = prisma14 as unknown as PrismaClient; // control-plane / legacy replica analog

      // Batch + members live ONLY on the NEW DB. The env is mirrored onto the legacy DB so the
      // passthrough read has an environment to filter on — but never the batch row.
      const ctx = await seedEnv(newDb, "route-new");
      await mirrorEnv(legacyDb, ctx, "route-legacy");
      await relaxFks(newDb);

      const memberId = newRunId("a");
      await seedMember(newDb, ctx, {
        id: memberId,
        friendlyId: "run_route_a",
        output: JSON.stringify({ from: "new" }),
      });
      await seedBatch(newDb, ctx, "batch_route_new", [memberId]);

      // Route wiring: splitEnabled + newClient + legacyReplica; passthrough handles throw.
      const splitPresenter = new ApiBatchResultsPresenter(throwingPrisma, throwingPrisma, {
        splitEnabled: true,
        newClient: prisma17 as unknown as PrismaReplicaClient,
        legacyReplica: prisma14 as unknown as PrismaReplicaClient,
      });

      const resolved = await splitPresenter.call("batch_route_new", env(ctx));

      expect(resolved).toBeDefined();
      expect(resolved!.id).toBe("batch_route_new");
      expect(resolved!.items).toHaveLength(1);
      expect(resolved!.items[0]).toEqual({
        ok: true,
        id: "run_route_a",
        taskIdentifier: "my-task",
        output: JSON.stringify({ from: "new" }),
        outputType: "application/json",
      });

      // Pre-fix route: no read-through deps => passthrough off the control-plane replica (the legacy
      // DB, which never received the batch) => undefined, i.e. the 404.
      const passthroughPresenter = new ApiBatchResultsPresenter(legacyDb, legacyDb);

      const missed = await passthroughPresenter.call("batch_route_new", env(ctx));
      expect(missed).toBeUndefined();
    }
  );
});
